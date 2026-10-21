'use strict';
const db = require('../config/db');
const model = require('../models/timetable');
const master = require('../models/master');
const { SECTION_LABEL, SECTION_JOINS } = require('../models/common');
const { notFound, invalid, conflict } = require('../utils/errors');
const { isDate, todayIn, addDays, DAY_NAMES } = require('../utils/dates');

/**
 * Slots that would collide with (day, period) for a staff member or a classroom, from a
 * date onwards. Semesters that do not overlap in time never clash. Two things are allowed:
 *   - a section with several classes in one period (lab batches, electives), even in one room;
 *   - a combined class: the same subject, staff member and room for several sections.
 */
async function findClashes(client, o) {
  const rows = (await client.query(
    `SELECT t.timetable_id, t.staff_id, t.classroom_id, t.section_id, t.subject_id, ${SECTION_LABEL} AS section_label
       FROM attendance.timetable t
       JOIN attendance.sections sec ON sec.section_id = t.section_id
       ${SECTION_JOINS}
       JOIN attendance.semesters ts ON ts.semester_id = t.semester_id
       JOIN attendance.semesters tgt ON tgt.semester_id = $2
      WHERE d.college_id = $1
        AND t.day_of_week = $3 AND t.period_id = $4
        AND (t.effective_to IS NULL OR t.effective_to >= $5)
        AND ts.start_date <= tgt.end_date AND ts.end_date >= tgt.start_date
        AND NOT (t.timetable_id = ANY($6::bigint[]))
        AND NOT (t.section_id = ANY($7::int[]))
        AND (t.staff_id = $8 OR t.classroom_id = $9)`,
    [o.collegeId, o.semesterId, o.day, o.periodId, o.from, o.excludeIds || [], o.excludeSectionIds || [], o.staffId, o.classroomId]
  )).rows;
  const out = [];
  for (const r of rows) {
    const sameSection = r.section_id === o.sectionId;
    const combined = !sameSection && r.subject_id === o.subjectId && r.staff_id === o.staffId && r.classroom_id === o.classroomId;
    if (combined) continue;
    if (r.staff_id === o.staffId) out.push(`the staff member already teaches ${r.section_label} in that period`);
    if (r.classroom_id === o.classroomId && !sameSection) out.push(`the classroom is already used by ${r.section_label} in that period`);
  }
  return [...new Set(out)];
}

/** End a slot from a date. A slot that never took effect and has no attendance is removed. */
async function retire(client, slot, from) {
  const used = (await client.query('SELECT 1 FROM attendance.records WHERE timetable_id = $1 LIMIT 1', [slot.timetable_id])).rowCount > 0;
  if (!used && slot.effective_from >= from) {
    await client.query('DELETE FROM attendance.class_swaps WHERE timetable_id = $1', [slot.timetable_id]);
    await client.query('DELETE FROM attendance.timetable_history WHERE timetable_id = $1', [slot.timetable_id]);
    await client.query('DELETE FROM attendance.class_sessions WHERE timetable_id = $1', [slot.timetable_id]);
    await client.query('DELETE FROM attendance.timetable WHERE timetable_id = $1', [slot.timetable_id]);
    return 'deleted';
  }
  await client.query('UPDATE attendance.timetable SET is_active = false, effective_to = $2 WHERE timetable_id = $1', [slot.timetable_id, addDays(from, -1)]);
  return 'closed';
}

/**
 * Create a class, or replace one (body.timetable_id) from a date. A period can hold several
 * classes of one section, so a new class never replaces another by position.
 */
async function saveSlot(scope, userId, body) {
  const section = await model.getSection(scope, body.section_id);
  if (!section) throw notFound('That section does not exist.');
  const day = parseInt(body.day_of_week, 10);
  if (!(day >= 1 && day <= 7)) throw invalid('Choose a day.');
  const pick = async (source, value, label) => {
    const hit = (await master.options({ ...scope, role: 'admin' }, source)).find((x) => String(x.value) === String(value));
    if (!hit) throw invalid(`Choose a ${label} from the list.`);
    return hit.value;
  };
  const periodId = await pick('periods', body.period_id, 'period');
  const subjectId = await pick('subjects', body.subject_id, 'subject');
  const staffId = await pick('staff', body.staff_id, 'staff member');
  const classroomId = await pick('classrooms', body.classroom_id, 'classroom');
  const today = todayIn(scope.timezone);
  const from = body.effective_from || addDays(today, 1);
  if (!isDate(from) || from < today) throw invalid('Effective-from date must be today or later.');

  return db.tx(async (c) => {
    let old = null;
    if (body.timetable_id) {
      old = await c.one('SELECT * FROM attendance.timetable WHERE timetable_id = $1 AND section_id = $2 AND is_active FOR UPDATE', [parseInt(body.timetable_id, 10) || 0, section.section_id]);
      if (!old) throw notFound('That class is no longer in the timetable.');
    }
    const clashes = await findClashes(c, {
      collegeId: section.college_id, semesterId: section.semester_id, day, periodId, from,
      staffId, classroomId, subjectId, sectionId: section.section_id, excludeIds: old ? [old.timetable_id] : [],
    });
    if (clashes.length) throw conflict(`${DAY_NAMES[day]} clash: ${clashes.join('; ')}.`);
    if (old) await retire(c, old, from);
    const row = await c.one(
      `INSERT INTO attendance.timetable (academic_year_id, semester_id, section_id, subject_id, staff_id, classroom_id, day_of_week, period_id, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [section.academic_year_id, section.semester_id, section.section_id, subjectId, staffId, classroomId, day, periodId, from]
    );
    await c.query(
      `INSERT INTO attendance.timetable_history (timetable_id, modified_by, change_type, old_staff_id, new_staff_id, old_subject_id, new_subject_id, old_classroom_id, new_classroom_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.timetable_id, userId, old ? 'replaced' : 'created', old ? old.staff_id : null, staffId, old ? old.subject_id : null, subjectId, old ? old.classroom_id : null, classroomId]
    );
    return { row, old };
  });
}

async function closeSlot(scope, userId, id, from) {
  const slot = await model.getSlot(scope, id);
  if (!slot) throw notFound('That slot does not exist.');
  const today = todayIn(scope.timezone);
  const date = from && isDate(from) && from >= today ? from : addDays(today, 1);
  await db.tx(async (c) => {
    const how = await retire(c, slot, date);
    if (how === 'closed') {
      await c.query(
        `INSERT INTO attendance.timetable_history (timetable_id, modified_by, change_type, old_staff_id, old_subject_id, old_classroom_id)
         VALUES ($1, $2, 'closed', $3, $4, $5)`,
        [slot.timetable_id, userId, slot.staff_id, slot.subject_id, slot.classroom_id]
      );
    }
  });
  return slot;
}

module.exports = { findClashes, retire, saveSlot, closeSlot };
