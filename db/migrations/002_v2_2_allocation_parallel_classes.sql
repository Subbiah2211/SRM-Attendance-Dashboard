-- =====================================================================
-- SRM attendance schema: v2.1 -> v2.2
-- Adds what a real class timetable sheet needs:
--   * subject short names (CN, AIML ...) and L-T-P hours
--   * subject and staff allocation per section and academic year
--   * more than one class in a period for one section: lab batches
--     (AIMLL / CNL) and electives (ST / CCBT)
--   * elective choices per student
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Subjects: the short name used in timetable cells, and L-T-P
-- ---------------------------------------------------------------------
ALTER TABLE attendance.subjects
    ADD COLUMN short_name      text,
    ADD COLUMN lecture_hours   integer,
    ADD COLUMN tutorial_hours  integer,
    ADD COLUMN practical_hours integer;
COMMENT ON COLUMN attendance.subjects.short_name IS 'Abbreviation used in timetable cells, for example CN or AIMLL.';
CREATE INDEX subjects_short_name_idx ON attendance.subjects (college_id, upper(short_name));

-- ---------------------------------------------------------------------
-- 2. Subject and staff allocation: per section, per academic year
-- ---------------------------------------------------------------------
ALTER TABLE attendance.staff_subjects
    ADD COLUMN section_id   integer REFERENCES attendance.sections(section_id) ON DELETE CASCADE,
    ADD COLUMN classroom_id integer REFERENCES attendance.classrooms(classroom_id);
COMMENT ON TABLE attendance.staff_subjects IS 'Who teaches which subject. With section_id set it is the allocation for that class in that academic year; classroom_id is the hall or lab when it differs from the class''s own hall.';

ALTER TABLE attendance.staff_subjects
    DROP CONSTRAINT staff_subjects_staff_id_subject_id_academic_year_id_semeste_key;
CREATE UNIQUE INDEX staff_subjects_allocation_key
    ON attendance.staff_subjects (staff_id, subject_id, academic_year_id, semester_id, COALESCE(section_id, 0));
CREATE INDEX staff_subjects_section_idx ON attendance.staff_subjects (section_id);

-- The academic year and semester of an allocation always follow its section.
CREATE FUNCTION attendance.set_allocation_term() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.section_id IS NOT NULL THEN
        SELECT s.academic_year_id, s.semester_id
          INTO NEW.academic_year_id, NEW.semester_id
          FROM attendance.sections s
         WHERE s.section_id = NEW.section_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_staff_subjects_term BEFORE INSERT OR UPDATE ON attendance.staff_subjects
    FOR EACH ROW EXECUTE FUNCTION attendance.set_allocation_term();

-- ---------------------------------------------------------------------
-- 3. Parallel classes: one section can have several slots in a period
--    (one per subject and staff member). v2.0 allowed exactly one.
-- ---------------------------------------------------------------------
DROP INDEX attendance.timetable_active_slot_idx;
CREATE UNIQUE INDEX timetable_active_slot_idx
    ON attendance.timetable (section_id, day_of_week, period_id, subject_id, staff_id) WHERE is_active;
CREATE INDEX timetable_section_slot_idx ON attendance.timetable (section_id, day_of_week, period_id);

-- ---------------------------------------------------------------------
-- 4. Elective choices
-- ---------------------------------------------------------------------
CREATE TABLE attendance.student_subjects (
    student_id  uuid    NOT NULL REFERENCES identity.students(student_id) ON DELETE CASCADE,
    subject_id  bigint  NOT NULL REFERENCES attendance.subjects(subject_id) ON DELETE CASCADE,
    semester_id integer NOT NULL REFERENCES attendance.semesters(semester_id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT student_subjects_pkey PRIMARY KEY (student_id, subject_id, semester_id)
);
COMMENT ON TABLE attendance.student_subjects IS 'Which students take an elective. A subject with no rows here for a section is taken by the whole section.';
CREATE INDEX student_subjects_subject_idx ON attendance.student_subjects (subject_id, semester_id);

CREATE FUNCTION attendance.takes_subject(p_student uuid, p_subject bigint, p_semester integer, p_section integer) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT EXISTS (
               SELECT 1 FROM attendance.student_subjects e
                WHERE e.student_id = p_student AND e.subject_id = p_subject AND e.semester_id = p_semester)
        OR NOT EXISTS (
               SELECT 1 FROM attendance.student_subjects e
                 JOIN identity.students s ON s.student_id = e.student_id
                WHERE e.subject_id = p_subject AND e.semester_id = p_semester AND s.section_id = p_section);
$$;
COMMENT ON FUNCTION attendance.takes_subject(uuid, bigint, integer, integer) IS 'True when the student is on the roll of the subject: listed for it, or nobody in the section is listed (so everyone takes it).';

-- ---------------------------------------------------------------------
-- 5. Uploads: two new types, and a link between the two uploads that
--    come from one class timetable sheet
-- ---------------------------------------------------------------------
ALTER TABLE attendance.import_batches DROP CONSTRAINT import_batches_type_check;
ALTER TABLE attendance.import_batches ADD CONSTRAINT import_batches_type_check CHECK (import_type IN
    ('departments', 'subjects', 'timetable', 'staff', 'students', 'classrooms', 'sections', 'allocation', 'electives'));
ALTER TABLE attendance.import_batches
    ADD COLUMN linked_batch_id bigint REFERENCES attendance.import_batches(batch_id);
COMMENT ON COLUMN attendance.import_batches.linked_batch_id IS 'The other upload created from the same class timetable sheet (allocation and timetable).';
