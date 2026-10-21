# Attendance register

College-wise dashboard for AI video based student attendance. Node.js (Express, EJS) in an
MVC layout, on PostgreSQL. It builds on the `srm_attendance` schema v2.0 and upgrades it to v2.1.

- Five roles: superadmin, admin, HOD, staff, student. Every login belongs to one college.
- The superadmin assigns module permissions (view, edit, delete, export) per role, per college.
- Attendance is marked automatically from the recognition pipeline's identification events,
  using each section's timetable.
- HODs see today's or earlier attendance by class, subject, staff member or period.
- Departments, subjects, timetables, staff, students, classrooms and sections upload from
  Excel or text-based PDF, with a preview before anything is saved.
- A class timetable sheet as the department publishes it (PDF or Excel) loads in one go: the
  day and hour grid becomes the timetable, and the subject and staff table under it becomes
  that class's subject and staff allocation for the academic year.

## Interface

- **Sign-in page**: a darker glass panel with lit input boxes and four pictures (staff, students,
  AI cameras, attendance). The pictures are drawn; to use photographs, put `staff`, `student`,
  `cctv` and `attendance` images (jpg, png or webp) in `src/public/img/login/`.
- **Full screen**: signing in takes the browser into full screen, so its tabs and address bar are
  hidden, and moving between pages keeps it (pages are swapped in place rather than reloaded).
  A browser only allows full screen as the result of a click, and always lets the user leave with
  Esc; when that happens a bar offers "Go full screen" again, and the top bar has a toggle. To make
  it impossible to leave, run the browser itself in kiosk mode (for example `chrome --kiosk <url>`).
- **Sidebar**: grouped menus with submenus, an icon on every item. Groups appear only when the role
  has view permission. Open groups are remembered per browser.
- **Surfaces**: cards, filter windows and forms are frosted glass over a tinted background, raised
  with layered shadows; every heading sits on a shaded band; input boxes are sunk and glow on focus.
  Light and dark themes.
- **Dashboard filters**: period (Today, Yesterday, Last 7 days, Last 30 days, or from-to),
  department, class, subject, staff, hour and AI camera. Below the figures, "Attendance by"
  regroups the same data by department, class, subject, staff, period or date.
- **AI camera view** (everyone except students): pick a camera to see the class in its room now,
  today's recognitions and counts. Admins see the college's cameras, HODs those of rooms their
  department uses, staff those of rooms they teach in. Live video appears when the camera has a
  "Live view address" (Cameras > Camera mapping): an HLS playlist, an MJPEG stream or a page of
  your video gateway. Browsers cannot play RTSP, and the address must not contain a password.
- **Staff details and Student details** have filters: department, class, semester, batch, gender,
  status, face registered; department, designation, type, status.
- No CDN: the font, the chart and video libraries and all icons are served by the app.
- Menu: `src/config/menu.js`. Icons, avatars and chips: `src/utils/ui.js`. Styles:
  `src/public/css/app.css`. Page swapping and full screen: `src/public/js/app.js`.

## Requirements

- Node.js 22.13 or later
- PostgreSQL 15 or later with the `pgcrypto` and `vector` (pgvector) extensions available.
  Developed and tested on PostgreSQL 16; the v2.0 schema file was dumped from 18.3.

## Set up

```bash
npm install
cp .env.example .env          # set DATABASE_URL and SESSION_SECRET
```

Then prepare the database in one of two ways.

| Your database | Command | What it does |
| --- | --- | --- |
| Empty | `npm run db:init` | Loads `db/base/000_schema_v2_0.sql`, then applies `db/migrations/` |
| Already has schema v2.0 or v2.1 (with or without data) | `npm run migrate` | Applies the migrations not yet applied (001: v2.1, 002: v2.2, 003: v2.3); v2.0 rows go to a college with code `default` |

`db/schema/srm_attendance_whole_schema_v2_3.sql` is the same result as one file, for `psql -f` on
an empty database. `npm run migrate` recognises a database created that way.

Create the first user, then start both processes:

```bash
npm run seed:superadmin -- --username superadmin --password 'Choose@Strong1'
npm start            # web, http://localhost:3000
npm run worker       # attendance engine; run it alongside the web process
```

Sign in with "Group administration" selected as the college.

## Try it with demo data

On an empty, migrated database:

```bash
npm run seed:demo    # 3 colleges; SRM VEC gets 96 students, a timetable, cameras and 10 days of attendance
npm run simulate     # writes identification events for classes that have started today, then runs the engine
```

`seed:demo` prints the demo sign-ins. `simulate` writes made-up recognitions, so the dashboard can
be tried without cameras or photos.

## First real set-up, in order

1. Superadmin: **Colleges** > add each college, then "Work in this college".
2. **Users** > add the college admin. Review **Module permissions** for the college.
3. Admin: **Academic setup** > academic year (mark it active), semesters, periods, holidays.
4. **Master data** > programs.
5. **Uploads**, in the order the page lists: departments, classrooms, staff, subjects, sections,
   students, then the class timetable sheets (or allocation and timetable separately), then
   elective choices. Each has an Excel template.
6. **Cameras** > "Map cameras to classrooms". The camera id must equal the id the pipeline sends.
7. Start the worker.

## Recognition service (camera to database)

`recognition/` is a Python program that reads the camera streams, compares faces with the
students' enrolled photos, and writes the matches the attendance worker consumes:

```bash
cd recognition && pip install -r requirements.txt
python enroll.py --college srm-vec --photos ./photos --consent-given   # once, from photos named by register number
python recognize.py --college srm-vec                                  # all day, next to npm start and npm run worker
```

`recognition/README.md` explains each step, the camera address file, tuning, speed, and the two
things to settle before real use: consent, and the licence of the face models (the InsightFace
pretrained models are for non-commercial research use only).

## Face enrolment by students at first sign-in

An active student whose face is not enrolled is taken to **Enrol your face** straight after
signing in (and after changing a first password). Nothing else opens until it is done.

- The student adds at least three photos: facing the camera, turned slightly left, turned
  slightly right. On a phone the file box opens the camera; on an `https` or `localhost` address
  the page can also use the device's camera directly. The browser converts each picture to JPEG.
- The server refuses the attempt, and keeps nothing, unless three photos pass: JPEG, exactly one
  face, large and sharp enough, all the same person, and not a face already enrolled for another
  student (that attempt is written to the audit log).
- Accepted photos are saved as `var/photos/<REGISTER NO>/front.jpg`, `left.jpg`, `right.jpg`
  (change the folder with `PHOTO_DIR`), and each is stored as a 512-number vector in
  `identity.face_embeddings`. `attendance.registration_sessions` and `registration_images` record
  who enrolled and where the files are. The consent date is set from the tick box.
- The student's page shows the photos to staff, HOD and admin so they can check them. HOD and
  admin can **Reset enrolment**, which deletes the photos and vectors; the student then enrols again.
- Settings: "Students must enrol their face at first sign-in" (on) and "Photos needed for face
  enrolment" (3). Students marked opted out are never asked.

The vectors are made by the same Python code as the recognition service. The application starts
`recognition/embed_service.py` itself on the first enrolment and keeps it running, so install the
recognition requirements on the web server too (`pip install -r recognition/requirements.txt`).
It looks for a virtual environment named `venv` or `.venv` in `recognition/` or the project
folder, then for `python`; set `PYTHON_BIN` to point somewhere else. The first enrolment after a
start is slower while the model loads. `FACE_MODEL` must be the same for the application and for
`recognize.py`: vectors of different models are never compared.

## How attendance gets marked

The recognition service inserts rows into `identity.identification_events`. It does not call
this application. The worker then:

1. Claims unconsumed events in batches (`FOR UPDATE SKIP LOCKED`).
2. Finds the camera's classroom, the college's local date and time, and the period whose window
   contains the event. The window opens `early_entry_minutes` before the period starts.
3. Finds the timetable slot in effect in that room, on that day, in that period, and checks the
   student belongs to its section.
4. Upserts one row in `attendance.records` per student, slot and date: `present`, or `late` after
   `late_after_minutes`. A record set by hand is never changed.
5. Writes `attendance.ingested_events` with the record id or the reason the event was ignored.

`absent_grace_minutes` after each period ends, the worker marks absentees and refreshes the
summaries. It marks nobody absent when the room's camera was offline in the period, or nobody in
the section was detected: the period is flagged "needs manual marking" and the staff member and
HOD are notified. Students who opted out, or have no registered face, are never auto-marked.

Thresholds are per college under **Settings** (`attendance.system_settings`).

## Layout (MVC)

```
src/
  app.js            Express app and middleware order
  server.js         web process
  worker.js         worker process (same models and services, no HTTP)
  config/           env, database pool, module catalogue and default permission matrix, master-data entities
  routes/index.js   the whole URL map; each route names the module and action it needs
  middlewares/      authenticate (session + scope), permit, csrf, respond, upload, errors
  controllers/      thin: read the request, call a service or model, render a view or return JSON
  services/         business rules: engine, attendance, imports, timetable, permissions, settings, auth, export
  models/           all SQL; every query takes the caller's scope
  importers/        Excel and PDF readers; table, grid and class timetable sheet parsers
  jobs/             ingestEvents, closePeriods, refreshSummaries, sendEmails
  views/            EJS pages per module, shared partials
  public/           one stylesheet, one script (no build step)
db/
  base/             schema v2.0 as received
  migrations/       001: v2.0 to v2.1, 002: v2.1 to v2.2, 003: v2.2 to v2.3
  schema/           whole schema v2.3 in one file
scripts/            migrate, create-superadmin, seed-demo, simulate-events
tests/              unit tests and end-to-end tests
recognition/        Python: enrol faces from photos, recognise them on camera streams
```

Every request passes two checks: the role's module permission (`middlewares/permit.js`), then
data scope inside the model (college, department, own classes, own record). Scope comes from the
session, never from request parameters. A record outside the caller's scope returns 404.

## Class timetable sheets

Upload the sheet a department publishes for a class, as PDF or Excel, with "Timetable" chosen:

```
PROGRAMME : B.E.                      Hall No : 504
SEMESTER  : V - CSE 3                 Academic Year : 2026-2027 (ODD Semester)
HOUR    1     2      3      4          5     6      7      8
Monday  CN    AIML   AIMLL / CNL       TP           MENT   LIB
Tuesday ST/CCBT ...
S.No  Subject Code  Subject Name                 CN   L T P  Staff Incharge            Dept
1     CS3561        Computer Networks            CN   4 0 0  Ms.S.Balaswathy / A.P     CSE
7     PIT202        (Professional Elective - II) ST   4 0 0  Ms. R. Anitha (Hall No.503) ...
```

It becomes two linked uploads, committed one after the other:

1. **Subject and staff allocation**, from the table: one row per subject and staff member, with
   the short name, L-T-P, the offering department, the elective category and the hall. Committing
   it creates or updates the subjects and stores who teaches what to this class this year
   (`attendance.staff_subjects`, listed under Master data > Subject allocation).
2. **Timetable**, from the grid: one row per class. A cell merged across two hours gives both
   hours. A cell with two subjects (`AIMLL / CNL`, `ST/CCBT`) gives parallel classes.

What to know:

- The class is found from the header: programme, semester (Roman or digits), department code
  and section. That section must exist. `B.E.`, `B.E` and `BE` are the same programme code.
- Staff are matched by name, ignoring titles and the order of initials: `Ms.S.Balaswathy` finds
  `Balaswathy S`. A name that is not in the staff master ("New Staff 5") is an error in the
  preview: type the staff code there, or add the person and open the preview again.
- Subjects with no code on the sheet (Training, Mentoring, Library) use their short name as the code.
- Theory classes use the sheet's hall. A hall in brackets after a staff name is used for that
  person's classes. Labs with no room on the sheet are highlighted: give each its lab room in
  the allocation preview, because attendance comes from the camera in the room.
- A subject with several staff (one elective taught in three halls) becomes one class per staff
  member, all in the same period.
- A sheet for an academic year other than the college's active year is refused.
- When the sheet names things the college has not entered yet (the programme, the class, halls,
  hours, staff, another department), the preview says so and the college admin gets
  **Set up what is missing**: one screen that lists them and creates the ticked ones. New staff
  get the staff code you type (a code is suggested) as username and first password. If the hour
  timings on the sheet differ from Academic setup > Periods, the screen says so; attendance
  follows Academic setup.
- The allocation can also be uploaded on its own from the Excel template, and edited under
  Master data > Subject allocation.

Parallel classes and attendance:

- A student is marked present in the class whose room they are seen in.
- Absent is recorded once per period, not once per parallel class: against the first class of
  the period for students with no mark in any of them.
- Upload **Elective choices** (register number, subject) to say who takes which elective. The
  roll of an elective is then only those students, absentees land on their own elective, and a
  student seen in another elective's hall is ignored with the reason kept.
- For lab batches (the whole class takes both labs, half at a time) the sheet does not say which
  batch is where, so an absentee of a split lab period is recorded against the first lab.

## Uploads

- Excel `.xlsx`, or a PDF with a text layer. Scanned PDFs are rejected; use the template.
- Column names are matched loosely (`Staff Code`, `staff_code`, `Dept`, ...). Templates list them.
- **Staff and student lists** can be uploaded as the office prints them, in Excel or PDF, as well
  as from the template. A class list may give its programme, semester and section once in the
  heading above the table (`SEMESTER : V - CSE 3`), and a staff list may be headed
  `Department of ...`; the heading then applies to every row. Headers such as `Register Number`,
  `Name of the Student`, `Father's Name`, `Parent Mobile`, `Employee ID` and `Name of the Faculty`
  are recognised. For students only the register number and name are required; the university id
  defaults to the register number. Parent names, mobiles and email are stored in
  `attendance.student_parents`.
- **People > Staff details** and **People > Student details** list what was loaded (designation,
  joining date, contact; class, batch, date of birth, parent, face registered) with an Upload
  button and the template. Status, class and similar fields are edited there; people are added
  by upload or under Users.
  On a student, admin and HOD can also edit the mobile number, date of birth and **Face registered**.
  Setting it to No deletes the stored face photos and vectors, and the student enrols again at next
  sign-in. Setting it to Yes without enrolled photos skips enrolment, but cameras cannot recognise
  the student, so they are marked absent unless staff mark them by hand.
- Timetables come as one row per slot, or as a grid: heading rows (`department_code`, `program_code`,
  `semester_no`, `section`), a `Day | P1 | P2 ...` header, and cells of `subject / staff / room`.
- A timetable upload replaces the whole week of every section in the file from the chosen date.
  Old slots are closed, not deleted, so earlier attendance keeps its subject and staff.
- New staff and students get their username as the first password unless the file has a
  `password` column. They must change it at first sign-in.
- An HOD can upload subjects, sections, staff, students, allocations, timetables and elective
  choices of the own department only.

## API

Every page is also served as JSON under `/api/v1` with the same permissions, for example
`GET /api/v1/attendance?date=2026-10-01&section_id=3`. Sign in with
`POST /api/v1/auth/login` (`college_code`, `username`, `password`); it sets the session cookie and
returns `csrf_token`, which goes in the `x-csrf-token` header of every non-GET request.

## Tests

```bash
npm test                                             # unit tests
TEST_DATABASE_URL=postgres://.../srm_attendance_test npm test   # plus end-to-end tests
```

The end-to-end tests wipe and rebuild the test database (its name must contain `test`). They cover
sign-in and lock-out, CSRF, isolation between colleges, HOD and staff scope, the HOD filters,
permission changes, corrections, manual marking, the engine, Excel uploads, timetable replacement
and clashes, substitutions, holidays, user management, exports and settings, and a class timetable
sheet PDF from upload to attendance with parallel classes and elective choices.

## Production notes

- Set `NODE_ENV=production`, a long `SESSION_SECRET`, and `COOKIE_SECURE=true` and
  `TRUST_PROXY=true` behind HTTPS.
- Run one worker. Several workers are safe (row locks), but one is enough.
- `STORAGE_DIR` holds uploaded files and generated reports; back it up with the database.
- Camera stream credentials never go in the database: `identity.cameras.source_ref` is a
  secret-store key only.

## Not included

- Enrolment by the office from the dashboard: students enrol themselves at sign-in, and the office
  can enrol a folder of photos with `recognition/enroll.py`.
- Liveness checks (a photo held up to the camera can be recognised as the person).
- OCR for scanned PDFs.
- Day-order timetables (the timetable is by weekday).
- Lab batch lists: which students are in which batch of a split lab period.
- A leave or on-duty workflow: `excused` is set by hand.
- `attendance.monthly_summary` is not refreshed by this application.
- PostgreSQL row-level security. Isolation is enforced in the models and covered by tests; RLS on
  `college_id` is a sensible second layer to add.
