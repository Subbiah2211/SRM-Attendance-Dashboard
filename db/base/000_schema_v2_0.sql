--
-- PostgreSQL database dump
--

\restrict QuRWcT76G4Faye50oxyzAOlhQqgvZpSou8pfwXCL6yMJm8eAxIz7SBmHjiBQRJw

-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: attendance; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA attendance;


ALTER SCHEMA attendance OWNER TO postgres;

--
-- Name: SCHEMA attendance; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON SCHEMA attendance IS 'Phase 2: academic structure, attendance marks, dashboard users';


--
-- Name: identity; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA identity;


ALTER SCHEMA identity OWNER TO postgres;

--
-- Name: SCHEMA identity; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON SCHEMA identity IS 'Phase 1: cameras, students, embeddings, identification events';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: log_status_change(); Type: FUNCTION; Schema: attendance; Owner: postgres
--

CREATE FUNCTION attendance.log_status_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO attendance.status_history (
            student_id, attendance_date, timetable_id,
            previous_status, new_status, modified_by
        ) VALUES (
            NEW.student_id, NEW.attendance_date, NEW.timetable_id,
            OLD.status, NEW.status, NEW.marked_by
        );
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION attendance.log_status_change() OWNER TO postgres;

--
-- Name: refresh_daily_summary(date); Type: FUNCTION; Schema: attendance; Owner: postgres
--

CREATE FUNCTION attendance.refresh_daily_summary(p_date date) RETURNS void
    LANGUAGE sql
    AS $$
    INSERT INTO attendance.daily_summary (
        attendance_date, department_id, section_id,
        total_students, present_count, absent_count, late_count, attendance_percentage
    )
    SELECT
        p_date,
        sec.department_id,
        sec.section_id,
        COUNT(DISTINCT s.student_id)::INTEGER,
        COUNT(r.attendance_id) FILTER (WHERE r.status IN ('present', 'late'))::INTEGER,
        COUNT(r.attendance_id) FILTER (WHERE r.status = 'absent')::INTEGER,
        COUNT(r.attendance_id) FILTER (WHERE r.status = 'late')::INTEGER,
        ROUND(
            100.0 * COUNT(r.attendance_id) FILTER (WHERE r.status IN ('present', 'late'))
            / NULLIF(COUNT(r.attendance_id), 0),
            2
        )
    FROM attendance.sections sec
    JOIN identity.students s ON s.section_id = sec.section_id
        AND s.enrollment_status = 'active'
    LEFT JOIN attendance.records r
        ON r.student_id = s.student_id
       AND r.attendance_date = p_date
    GROUP BY sec.department_id, sec.section_id
    ON CONFLICT (attendance_date, section_id) DO UPDATE
    SET total_students          = EXCLUDED.total_students,
        present_count           = EXCLUDED.present_count,
        absent_count            = EXCLUDED.absent_count,
        late_count              = EXCLUDED.late_count,
        attendance_percentage   = EXCLUDED.attendance_percentage;
$$;


ALTER FUNCTION attendance.refresh_daily_summary(p_date date) OWNER TO postgres;

--
-- Name: refresh_defaulter_alerts(); Type: FUNCTION; Schema: attendance; Owner: postgres
--

CREATE FUNCTION attendance.refresh_defaulter_alerts() RETURNS void
    LANGUAGE sql
    AS $$
    INSERT INTO attendance.alerts (student_id, subject_id, semester_id, percentage, alert_type)
    SELECT
        student_id,
        subject_id,
        semester_id,
        percentage,
        CASE
            WHEN percentage < 50 THEN 'critical'
            WHEN percentage < 60 THEN 'below60'
            ELSE 'below75'
        END
    FROM attendance.subject_summary
    WHERE percentage < 75
    ON CONFLICT (student_id, subject_id, semester_id) DO UPDATE
    SET percentage   = EXCLUDED.percentage,
        alert_type   = EXCLUDED.alert_type,
        generated_at = now();
$$;


ALTER FUNCTION attendance.refresh_defaulter_alerts() OWNER TO postgres;

--
-- Name: refresh_subject_summary(); Type: FUNCTION; Schema: attendance; Owner: postgres
--

CREATE FUNCTION attendance.refresh_subject_summary() RETURNS void
    LANGUAGE sql
    AS $$
    INSERT INTO attendance.subject_summary (
        student_id, subject_id, academic_year_id, semester_id,
        total_classes, attended_classes, absent_classes, late_classes, percentage, last_updated
    )
    SELECT
        r.student_id,
        t.subject_id,
        t.academic_year_id,
        t.semester_id,
        COUNT(*)::INTEGER,
        COUNT(*) FILTER (WHERE r.status IN ('present', 'late'))::INTEGER,
        COUNT(*) FILTER (WHERE r.status = 'absent')::INTEGER,
        COUNT(*) FILTER (WHERE r.status = 'late')::INTEGER,
        ROUND(
            100.0 * COUNT(*) FILTER (WHERE r.status IN ('present', 'late'))
            / NULLIF(COUNT(*), 0),
            2
        ),
        now()
    FROM attendance.records r
    JOIN attendance.timetable t ON t.timetable_id = r.timetable_id
    GROUP BY r.student_id, t.subject_id, t.academic_year_id, t.semester_id
    ON CONFLICT (student_id, subject_id, semester_id) DO UPDATE
    SET total_classes    = EXCLUDED.total_classes,
        attended_classes = EXCLUDED.attended_classes,
        absent_classes   = EXCLUDED.absent_classes,
        late_classes     = EXCLUDED.late_classes,
        percentage       = EXCLUDED.percentage,
        last_updated     = now();
$$;


ALTER FUNCTION attendance.refresh_subject_summary() OWNER TO postgres;

--
-- Name: mark_face_registered(); Type: FUNCTION; Schema: identity; Owner: postgres
--

CREATE FUNCTION identity.mark_face_registered() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE identity.students
    SET face_registered = true
    WHERE student_id = NEW.student_id;
    RETURN NEW;
END;
$$;


ALTER FUNCTION identity.mark_face_registered() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: academic_years; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.academic_years (
    academic_year_id integer NOT NULL,
    label text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    CONSTRAINT academic_years_check CHECK ((end_date > start_date))
);


ALTER TABLE attendance.academic_years OWNER TO postgres;

--
-- Name: academic_years_academic_year_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.academic_years ALTER COLUMN academic_year_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.academic_years_academic_year_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: alerts; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.alerts (
    alert_id bigint NOT NULL,
    student_id uuid NOT NULL,
    subject_id bigint NOT NULL,
    semester_id integer NOT NULL,
    percentage numeric(5,2) NOT NULL,
    alert_type text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alerts_alert_type_check CHECK ((alert_type = ANY (ARRAY['below75'::text, 'below60'::text, 'critical'::text])))
);


ALTER TABLE attendance.alerts OWNER TO postgres;

--
-- Name: alerts_alert_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.alerts ALTER COLUMN alert_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.alerts_alert_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_logs; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.audit_logs (
    audit_id bigint NOT NULL,
    user_id bigint,
    action text NOT NULL,
    table_name text,
    record_id text,
    action_time timestamp with time zone DEFAULT now() NOT NULL,
    ip_address inet
);


ALTER TABLE attendance.audit_logs OWNER TO postgres;

--
-- Name: audit_logs_audit_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.audit_logs ALTER COLUMN audit_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.audit_logs_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: camera_health_logs; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.camera_health_logs (
    log_id bigint NOT NULL,
    camera_id text NOT NULL,
    status text NOT NULL,
    network_latency_ms integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT camera_health_logs_status_check CHECK ((status = ANY (ARRAY['online'::text, 'offline'::text])))
);


ALTER TABLE attendance.camera_health_logs OWNER TO postgres;

--
-- Name: camera_health_logs_log_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.camera_health_logs ALTER COLUMN log_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.camera_health_logs_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: class_swaps; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.class_swaps (
    swap_id bigint NOT NULL,
    original_staff_id bigint NOT NULL,
    replacement_staff_id bigint NOT NULL,
    timetable_id bigint NOT NULL,
    swap_date date NOT NULL,
    approved_by bigint,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT class_swaps_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


ALTER TABLE attendance.class_swaps OWNER TO postgres;

--
-- Name: class_swaps_swap_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.class_swaps ALTER COLUMN swap_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.class_swaps_swap_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: classrooms; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.classrooms (
    classroom_id integer NOT NULL,
    room_number text NOT NULL,
    block_name text,
    floor_no integer,
    capacity integer,
    has_cctv boolean DEFAULT true NOT NULL,
    remarks text
);


ALTER TABLE attendance.classrooms OWNER TO postgres;

--
-- Name: classrooms_classroom_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.classrooms ALTER COLUMN classroom_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.classrooms_classroom_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: corrections; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.corrections (
    correction_id bigint NOT NULL,
    attendance_id bigint NOT NULL,
    old_status text NOT NULL,
    new_status text NOT NULL,
    reason text NOT NULL,
    corrected_by bigint NOT NULL,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.corrections OWNER TO postgres;

--
-- Name: corrections_correction_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.corrections ALTER COLUMN correction_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.corrections_correction_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: daily_summary; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.daily_summary (
    summary_id bigint NOT NULL,
    attendance_date date NOT NULL,
    department_id integer NOT NULL,
    section_id integer NOT NULL,
    total_students integer DEFAULT 0 NOT NULL,
    present_count integer DEFAULT 0 NOT NULL,
    absent_count integer DEFAULT 0 NOT NULL,
    late_count integer DEFAULT 0 NOT NULL,
    attendance_percentage numeric(5,2)
);


ALTER TABLE attendance.daily_summary OWNER TO postgres;

--
-- Name: daily_summary_summary_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.daily_summary ALTER COLUMN summary_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.daily_summary_summary_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: departments; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.departments (
    department_id integer NOT NULL,
    department_code text NOT NULL,
    department_name text NOT NULL,
    hod_staff_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.departments OWNER TO postgres;

--
-- Name: departments_department_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.departments ALTER COLUMN department_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.departments_department_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: email_queue; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.email_queue (
    email_id bigint NOT NULL,
    student_id uuid,
    email text NOT NULL,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT email_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


ALTER TABLE attendance.email_queue OWNER TO postgres;

--
-- Name: email_queue_email_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.email_queue ALTER COLUMN email_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.email_queue_email_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: holidays; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.holidays (
    holiday_id bigint NOT NULL,
    academic_year_id integer NOT NULL,
    holiday_name text NOT NULL,
    holiday_date date NOT NULL,
    holiday_type text,
    CONSTRAINT holidays_holiday_type_check CHECK ((holiday_type = ANY (ARRAY['government'::text, 'college'::text, 'exam'::text, 'festival'::text])))
);


ALTER TABLE attendance.holidays OWNER TO postgres;

--
-- Name: holidays_holiday_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.holidays ALTER COLUMN holiday_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.holidays_holiday_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ingested_events; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.ingested_events (
    ingest_id bigint NOT NULL,
    event_id uuid NOT NULL,
    attendance_id bigint,
    ignored_reason text,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.ingested_events OWNER TO postgres;

--
-- Name: TABLE ingested_events; Type: COMMENT; Schema: attendance; Owner: postgres
--

COMMENT ON TABLE attendance.ingested_events IS 'Idempotency for Phase 2: each identification event is applied at most once.';


--
-- Name: ingested_events_ingest_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.ingested_events ALTER COLUMN ingest_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.ingested_events_ingest_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: monthly_summary; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.monthly_summary (
    summary_id bigint NOT NULL,
    academic_year_id integer NOT NULL,
    month_no integer NOT NULL,
    department_id integer NOT NULL,
    section_id integer NOT NULL,
    total_classes integer,
    total_present integer,
    total_absent integer,
    attendance_percentage numeric(5,2),
    CONSTRAINT monthly_summary_month_no_check CHECK (((month_no >= 1) AND (month_no <= 12)))
);


ALTER TABLE attendance.monthly_summary OWNER TO postgres;

--
-- Name: monthly_summary_summary_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.monthly_summary ALTER COLUMN summary_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.monthly_summary_summary_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notifications; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.notifications (
    notification_id bigint NOT NULL,
    user_id bigint NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    notification_type text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_notification_type_check CHECK ((notification_type = ANY (ARRAY['attendance'::text, 'leave'::text, 'announcement'::text, 'system'::text])))
);


ALTER TABLE attendance.notifications OWNER TO postgres;

--
-- Name: notifications_notification_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.notifications ALTER COLUMN notification_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.notifications_notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: periods; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.periods (
    period_id integer NOT NULL,
    period_no integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    duration_minutes integer NOT NULL,
    CONSTRAINT periods_check CHECK ((end_time > start_time)),
    CONSTRAINT periods_duration_minutes_check CHECK ((duration_minutes > 0))
);


ALTER TABLE attendance.periods OWNER TO postgres;

--
-- Name: periods_period_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.periods ALTER COLUMN period_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.periods_period_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: programs; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.programs (
    program_id integer NOT NULL,
    program_code text NOT NULL,
    program_name text NOT NULL,
    duration_years integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT programs_duration_years_check CHECK ((duration_years > 0))
);


ALTER TABLE attendance.programs OWNER TO postgres;

--
-- Name: programs_program_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.programs ALTER COLUMN program_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.programs_program_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: records; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.records (
    attendance_id bigint NOT NULL,
    student_id uuid NOT NULL,
    timetable_id bigint NOT NULL,
    attendance_date date NOT NULL,
    entry_time timestamp with time zone,
    exit_time timestamp with time zone,
    duration_minutes integer,
    attendance_source text DEFAULT 'ai'::text NOT NULL,
    confidence real,
    status text NOT NULL,
    marked_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT records_attendance_source_check CHECK ((attendance_source = ANY (ARRAY['ai'::text, 'manual'::text, 'imported'::text]))),
    CONSTRAINT records_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'late'::text, 'excused'::text])))
);


ALTER TABLE attendance.records OWNER TO postgres;

--
-- Name: records_attendance_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.records ALTER COLUMN attendance_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.records_attendance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: registration_images; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.registration_images (
    image_id bigint NOT NULL,
    session_id bigint NOT NULL,
    student_id uuid NOT NULL,
    pose text,
    storage_ref text NOT NULL,
    quality_ok boolean DEFAULT false NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT registration_images_pose_check CHECK ((pose = ANY (ARRAY['front'::text, 'left'::text, 'right'::text])))
);


ALTER TABLE attendance.registration_images OWNER TO postgres;

--
-- Name: COLUMN registration_images.storage_ref; Type: COMMENT; Schema: attendance; Owner: postgres
--

COMMENT ON COLUMN attendance.registration_images.storage_ref IS 'Object-store key, not a vector. Identity service reads this to embed.';


--
-- Name: registration_images_image_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.registration_images ALTER COLUMN image_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.registration_images_image_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: registration_sessions; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.registration_sessions (
    session_id bigint NOT NULL,
    student_id uuid NOT NULL,
    registered_by bigint,
    registered_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.registration_sessions OWNER TO postgres;

--
-- Name: registration_sessions_session_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.registration_sessions ALTER COLUMN session_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.registration_sessions_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: report_exports; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.report_exports (
    export_id bigint NOT NULL,
    exported_by bigint NOT NULL,
    report_name text NOT NULL,
    report_type text NOT NULL,
    file_path text,
    exported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT report_exports_report_type_check CHECK ((report_type = ANY (ARRAY['excel'::text, 'pdf'::text])))
);


ALTER TABLE attendance.report_exports OWNER TO postgres;

--
-- Name: report_exports_export_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.report_exports ALTER COLUMN export_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.report_exports_export_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: roles; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.roles (
    role_id integer NOT NULL,
    role_name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.roles OWNER TO postgres;

--
-- Name: roles_role_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.roles ALTER COLUMN role_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.roles_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sections; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.sections (
    section_id integer NOT NULL,
    department_id integer NOT NULL,
    program_id integer NOT NULL,
    academic_year_id integer NOT NULL,
    semester_id integer NOT NULL,
    section_name text NOT NULL,
    strength integer DEFAULT 0 NOT NULL,
    CONSTRAINT sections_strength_check CHECK ((strength >= 0))
);


ALTER TABLE attendance.sections OWNER TO postgres;

--
-- Name: sections_section_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.sections ALTER COLUMN section_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.sections_section_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: semesters; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.semesters (
    semester_id integer NOT NULL,
    academic_year_id integer NOT NULL,
    semester_no integer NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    CONSTRAINT semesters_check CHECK ((end_date > start_date)),
    CONSTRAINT semesters_semester_no_check CHECK (((semester_no >= 1) AND (semester_no <= 10)))
);


ALTER TABLE attendance.semesters OWNER TO postgres;

--
-- Name: semesters_semester_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.semesters ALTER COLUMN semester_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.semesters_semester_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: staff; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.staff (
    staff_id bigint NOT NULL,
    user_id bigint NOT NULL,
    staff_code text NOT NULL,
    designation text,
    department_id integer NOT NULL,
    employee_type text DEFAULT 'regular'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    joining_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_employee_type_check CHECK ((employee_type = ANY (ARRAY['regular'::text, 'contract'::text, 'visiting'::text]))),
    CONSTRAINT staff_status_check CHECK ((status = ANY (ARRAY['active'::text, 'medical_leave'::text, 'relieved'::text])))
);


ALTER TABLE attendance.staff OWNER TO postgres;

--
-- Name: staff_sections; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.staff_sections (
    staff_section_id bigint NOT NULL,
    staff_id bigint NOT NULL,
    section_id integer NOT NULL,
    role text NOT NULL,
    CONSTRAINT staff_sections_role_check CHECK ((role = ANY (ARRAY['subject_staff'::text, 'class_advisor'::text, 'mentor'::text])))
);


ALTER TABLE attendance.staff_sections OWNER TO postgres;

--
-- Name: staff_sections_staff_section_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.staff_sections ALTER COLUMN staff_section_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.staff_sections_staff_section_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: staff_staff_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.staff ALTER COLUMN staff_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.staff_staff_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: staff_subjects; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.staff_subjects (
    staff_subject_id bigint NOT NULL,
    staff_id bigint NOT NULL,
    subject_id bigint NOT NULL,
    academic_year_id integer NOT NULL,
    semester_id integer NOT NULL
);


ALTER TABLE attendance.staff_subjects OWNER TO postgres;

--
-- Name: staff_subjects_staff_subject_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.staff_subjects ALTER COLUMN staff_subject_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.staff_subjects_staff_subject_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: status_history; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.status_history (
    history_id bigint NOT NULL,
    student_id uuid NOT NULL,
    attendance_date date NOT NULL,
    timetable_id bigint NOT NULL,
    previous_status text,
    new_status text NOT NULL,
    modified_by bigint,
    modified_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.status_history OWNER TO postgres;

--
-- Name: status_history_history_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.status_history ALTER COLUMN history_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.status_history_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: student_parents; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.student_parents (
    parent_id bigint NOT NULL,
    student_id uuid NOT NULL,
    father_name text,
    mother_name text,
    guardian_name text,
    father_mobile text,
    mother_mobile text,
    guardian_mobile text,
    email text
);


ALTER TABLE attendance.student_parents OWNER TO postgres;

--
-- Name: student_parents_parent_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.student_parents ALTER COLUMN parent_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.student_parents_parent_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subject_categories; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.subject_categories (
    category_id integer NOT NULL,
    category_name text NOT NULL
);


ALTER TABLE attendance.subject_categories OWNER TO postgres;

--
-- Name: subject_categories_category_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.subject_categories ALTER COLUMN category_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.subject_categories_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subject_summary; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.subject_summary (
    summary_id bigint NOT NULL,
    student_id uuid NOT NULL,
    subject_id bigint NOT NULL,
    academic_year_id integer NOT NULL,
    semester_id integer NOT NULL,
    total_classes integer DEFAULT 0 NOT NULL,
    attended_classes integer DEFAULT 0 NOT NULL,
    absent_classes integer DEFAULT 0 NOT NULL,
    late_classes integer DEFAULT 0 NOT NULL,
    percentage numeric(5,2),
    last_updated timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.subject_summary OWNER TO postgres;

--
-- Name: subject_summary_summary_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.subject_summary ALTER COLUMN summary_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.subject_summary_summary_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subjects; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.subjects (
    subject_id bigint NOT NULL,
    subject_code text NOT NULL,
    subject_name text NOT NULL,
    category_id integer,
    department_id integer NOT NULL,
    semester_no integer,
    credits numeric(3,1),
    total_hours integer,
    is_lab boolean DEFAULT false NOT NULL
);


ALTER TABLE attendance.subjects OWNER TO postgres;

--
-- Name: subjects_subject_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.subjects ALTER COLUMN subject_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.subjects_subject_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: system_settings; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.system_settings (
    setting_key text NOT NULL,
    setting_value text NOT NULL,
    description text
);


ALTER TABLE attendance.system_settings OWNER TO postgres;

--
-- Name: timetable; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.timetable (
    timetable_id bigint NOT NULL,
    academic_year_id integer NOT NULL,
    semester_id integer NOT NULL,
    section_id integer NOT NULL,
    subject_id bigint NOT NULL,
    staff_id bigint NOT NULL,
    classroom_id integer NOT NULL,
    day_of_week integer NOT NULL,
    period_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT timetable_day_of_week_check CHECK (((day_of_week >= 1) AND (day_of_week <= 7)))
);


ALTER TABLE attendance.timetable OWNER TO postgres;

--
-- Name: timetable_history; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.timetable_history (
    history_id bigint NOT NULL,
    timetable_id bigint NOT NULL,
    modified_by bigint,
    old_staff_id bigint,
    new_staff_id bigint,
    modified_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE attendance.timetable_history OWNER TO postgres;

--
-- Name: timetable_history_history_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.timetable_history ALTER COLUMN history_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.timetable_history_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: timetable_timetable_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.timetable ALTER COLUMN timetable_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.timetable_timetable_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: unknown_reviews; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.unknown_reviews (
    review_id bigint NOT NULL,
    detection_id uuid NOT NULL,
    reviewed boolean DEFAULT false NOT NULL,
    reviewed_by bigint,
    remarks text,
    reviewed_at timestamp with time zone
);


ALTER TABLE attendance.unknown_reviews OWNER TO postgres;

--
-- Name: unknown_reviews_review_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.unknown_reviews ALTER COLUMN review_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.unknown_reviews_review_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_sessions; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.user_sessions (
    session_id bigint NOT NULL,
    user_id bigint NOT NULL,
    session_token text NOT NULL,
    login_at timestamp with time zone DEFAULT now() NOT NULL,
    logout_at timestamp with time zone,
    ip_address inet,
    device text
);


ALTER TABLE attendance.user_sessions OWNER TO postgres;

--
-- Name: user_sessions_session_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.user_sessions ALTER COLUMN session_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.user_sessions_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.users (
    user_id bigint NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role_id integer NOT NULL,
    department_id integer,
    first_name text NOT NULL,
    last_name text,
    email text,
    mobile text,
    status text DEFAULT 'active'::text NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


ALTER TABLE attendance.users OWNER TO postgres;

--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.users ALTER COLUMN user_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.users_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cameras; Type: TABLE; Schema: identity; Owner: postgres
--

CREATE TABLE identity.cameras (
    camera_id text NOT NULL,
    location_label text NOT NULL,
    source_ref text NOT NULL,
    classroom_id integer,
    roi real[],
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE identity.cameras OWNER TO postgres;

--
-- Name: COLUMN cameras.source_ref; Type: COMMENT; Schema: identity; Owner: postgres
--

COMMENT ON COLUMN identity.cameras.source_ref IS 'Lookup key for the secret store. Never store RTSP passwords in this table.';


--
-- Name: vw_camera_dashboard; Type: VIEW; Schema: attendance; Owner: postgres
--

CREATE VIEW attendance.vw_camera_dashboard AS
 SELECT c.camera_id,
    c.location_label,
    c.enabled,
    cl.room_number,
    cl.block_name
   FROM (identity.cameras c
     LEFT JOIN attendance.classrooms cl ON ((cl.classroom_id = c.classroom_id)));


ALTER VIEW attendance.vw_camera_dashboard OWNER TO postgres;

--
-- Name: vw_daily_report; Type: VIEW; Schema: attendance; Owner: postgres
--

CREATE VIEW attendance.vw_daily_report AS
 SELECT r.attendance_date,
    sub.subject_name,
    sec.section_name,
    count(*) FILTER (WHERE (r.status = ANY (ARRAY['present'::text, 'late'::text]))) AS present,
    count(*) FILTER (WHERE (r.status = 'late'::text)) AS late,
    count(*) FILTER (WHERE (r.status = 'absent'::text)) AS absent
   FROM (((attendance.records r
     JOIN attendance.timetable t ON ((t.timetable_id = r.timetable_id)))
     JOIN attendance.subjects sub ON ((sub.subject_id = t.subject_id)))
     JOIN attendance.sections sec ON ((sec.section_id = t.section_id)))
  GROUP BY r.attendance_date, sub.subject_id, sub.subject_name, sec.section_id, sec.section_name;


ALTER VIEW attendance.vw_daily_report OWNER TO postgres;

--
-- Name: students; Type: TABLE; Schema: identity; Owner: postgres
--

CREATE TABLE identity.students (
    student_id uuid DEFAULT gen_random_uuid() NOT NULL,
    university_id text NOT NULL,
    full_name text NOT NULL,
    user_id bigint,
    section_id integer,
    register_no text,
    admission_no text,
    roll_no text,
    batch_year integer,
    gender text,
    dob date,
    enrollment_status text DEFAULT 'active'::text NOT NULL,
    consent_granted_at timestamp with time zone,
    face_registered boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT students_enrollment_status_check CHECK ((enrollment_status = ANY (ARRAY['active'::text, 'withdrawn'::text, 'graduated'::text, 'opted_out'::text]))),
    CONSTRAINT students_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text])))
);


ALTER TABLE identity.students OWNER TO postgres;

--
-- Name: COLUMN students.university_id; Type: COMMENT; Schema: identity; Owner: postgres
--

COMMENT ON COLUMN identity.students.university_id IS 'SIS identifier. This is the join key carried on identification events.';


--
-- Name: vw_student_attendance; Type: VIEW; Schema: attendance; Owner: postgres
--

CREATE VIEW attendance.vw_student_attendance AS
 SELECT s.student_id,
    s.university_id,
    s.full_name,
    sub.subject_name,
    count(r.attendance_id) AS total,
    count(r.attendance_id) FILTER (WHERE (r.status = ANY (ARRAY['present'::text, 'late'::text]))) AS attended,
    round(((100.0 * (count(r.attendance_id) FILTER (WHERE (r.status = ANY (ARRAY['present'::text, 'late'::text]))))::numeric) / (NULLIF(count(r.attendance_id), 0))::numeric), 2) AS percentage
   FROM (((identity.students s
     LEFT JOIN attendance.records r ON ((r.student_id = s.student_id)))
     LEFT JOIN attendance.timetable t ON ((t.timetable_id = r.timetable_id)))
     LEFT JOIN attendance.subjects sub ON ((sub.subject_id = t.subject_id)))
  GROUP BY s.student_id, s.university_id, s.full_name, sub.subject_id, sub.subject_name;


ALTER VIEW attendance.vw_student_attendance OWNER TO postgres;

--
-- Name: vw_defaulters; Type: VIEW; Schema: attendance; Owner: postgres
--

CREATE VIEW attendance.vw_defaulters AS
 SELECT student_id,
    university_id,
    full_name,
    subject_name,
    total,
    attended,
    percentage
   FROM attendance.vw_student_attendance
  WHERE (percentage < (75)::numeric);


ALTER VIEW attendance.vw_defaulters OWNER TO postgres;

--
-- Name: unresolved_detections; Type: TABLE; Schema: identity; Owner: postgres
--

CREATE TABLE identity.unresolved_detections (
    detection_id uuid DEFAULT gen_random_uuid() NOT NULL,
    camera_id text NOT NULL,
    frame_captured_at timestamp with time zone NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    track_id integer,
    stage text NOT NULL,
    reason text NOT NULL,
    detector_score real NOT NULL,
    box real[] NOT NULL,
    best_similarity real,
    margin real,
    quality_metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_version text NOT NULL,
    embedding public.vector(512),
    CONSTRAINT unresolved_detections_stage_check CHECK ((stage = ANY (ARRAY['quality'::text, 'match'::text])))
);


ALTER TABLE identity.unresolved_detections OWNER TO postgres;

--
-- Name: vw_unknown_reviews; Type: VIEW; Schema: attendance; Owner: postgres
--

CREATE VIEW attendance.vw_unknown_reviews AS
 SELECT u.detection_id,
    u.camera_id,
    u.frame_captured_at,
    u.stage,
    u.reason,
    u.best_similarity,
    COALESCE(r.reviewed, false) AS reviewed,
    r.remarks
   FROM (identity.unresolved_detections u
     LEFT JOIN attendance.unknown_reviews r ON ((r.detection_id = u.detection_id)));


ALTER VIEW attendance.vw_unknown_reviews OWNER TO postgres;

--
-- Name: working_days; Type: TABLE; Schema: attendance; Owner: postgres
--

CREATE TABLE attendance.working_days (
    working_day_id bigint NOT NULL,
    academic_year_id integer NOT NULL,
    work_date date NOT NULL,
    is_working boolean DEFAULT true NOT NULL
);


ALTER TABLE attendance.working_days OWNER TO postgres;

--
-- Name: working_days_working_day_id_seq; Type: SEQUENCE; Schema: attendance; Owner: postgres
--

ALTER TABLE attendance.working_days ALTER COLUMN working_day_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME attendance.working_days_working_day_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: face_embeddings; Type: TABLE; Schema: identity; Owner: postgres
--

CREATE TABLE identity.face_embeddings (
    embedding_id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    embedding public.vector(512) NOT NULL,
    model_version text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT face_embeddings_source_check CHECK ((source = ANY (ARRAY['enrollment'::text, 're-enrollment'::text])))
);


ALTER TABLE identity.face_embeddings OWNER TO postgres;

--
-- Name: identification_events; Type: TABLE; Schema: identity; Owner: postgres
--

CREATE TABLE identity.identification_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    camera_id text NOT NULL,
    confidence real NOT NULL,
    frame_captured_at timestamp with time zone NOT NULL,
    matched_at timestamp with time zone DEFAULT now() NOT NULL,
    model_version text NOT NULL,
    track_id integer,
    consumed boolean DEFAULT false NOT NULL,
    consumed_at timestamp with time zone
);


ALTER TABLE identity.identification_events OWNER TO postgres;

--
-- Name: academic_years academic_years_label_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.academic_years
    ADD CONSTRAINT academic_years_label_key UNIQUE (label);


--
-- Name: academic_years academic_years_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.academic_years
    ADD CONSTRAINT academic_years_pkey PRIMARY KEY (academic_year_id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (alert_id);


--
-- Name: alerts alerts_student_id_subject_id_semester_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.alerts
    ADD CONSTRAINT alerts_student_id_subject_id_semester_id_key UNIQUE (student_id, subject_id, semester_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (audit_id);


--
-- Name: camera_health_logs camera_health_logs_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.camera_health_logs
    ADD CONSTRAINT camera_health_logs_pkey PRIMARY KEY (log_id);


--
-- Name: class_swaps class_swaps_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.class_swaps
    ADD CONSTRAINT class_swaps_pkey PRIMARY KEY (swap_id);


--
-- Name: class_swaps class_swaps_timetable_id_swap_date_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.class_swaps
    ADD CONSTRAINT class_swaps_timetable_id_swap_date_key UNIQUE (timetable_id, swap_date);


--
-- Name: classrooms classrooms_block_name_room_number_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.classrooms
    ADD CONSTRAINT classrooms_block_name_room_number_key UNIQUE (block_name, room_number);


--
-- Name: classrooms classrooms_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.classrooms
    ADD CONSTRAINT classrooms_pkey PRIMARY KEY (classroom_id);


--
-- Name: corrections corrections_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.corrections
    ADD CONSTRAINT corrections_pkey PRIMARY KEY (correction_id);


--
-- Name: daily_summary daily_summary_attendance_date_section_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.daily_summary
    ADD CONSTRAINT daily_summary_attendance_date_section_id_key UNIQUE (attendance_date, section_id);


--
-- Name: daily_summary daily_summary_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.daily_summary
    ADD CONSTRAINT daily_summary_pkey PRIMARY KEY (summary_id);


--
-- Name: departments departments_department_code_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.departments
    ADD CONSTRAINT departments_department_code_key UNIQUE (department_code);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);


--
-- Name: email_queue email_queue_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.email_queue
    ADD CONSTRAINT email_queue_pkey PRIMARY KEY (email_id);


--
-- Name: holidays holidays_academic_year_id_holiday_date_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.holidays
    ADD CONSTRAINT holidays_academic_year_id_holiday_date_key UNIQUE (academic_year_id, holiday_date);


--
-- Name: holidays holidays_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.holidays
    ADD CONSTRAINT holidays_pkey PRIMARY KEY (holiday_id);


--
-- Name: ingested_events ingested_events_event_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.ingested_events
    ADD CONSTRAINT ingested_events_event_id_key UNIQUE (event_id);


--
-- Name: ingested_events ingested_events_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.ingested_events
    ADD CONSTRAINT ingested_events_pkey PRIMARY KEY (ingest_id);


--
-- Name: monthly_summary monthly_summary_academic_year_id_month_no_section_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.monthly_summary
    ADD CONSTRAINT monthly_summary_academic_year_id_month_no_section_id_key UNIQUE (academic_year_id, month_no, section_id);


--
-- Name: monthly_summary monthly_summary_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.monthly_summary
    ADD CONSTRAINT monthly_summary_pkey PRIMARY KEY (summary_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (notification_id);


--
-- Name: periods periods_period_no_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.periods
    ADD CONSTRAINT periods_period_no_key UNIQUE (period_no);


--
-- Name: periods periods_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.periods
    ADD CONSTRAINT periods_pkey PRIMARY KEY (period_id);


--
-- Name: programs programs_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.programs
    ADD CONSTRAINT programs_pkey PRIMARY KEY (program_id);


--
-- Name: programs programs_program_code_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.programs
    ADD CONSTRAINT programs_program_code_key UNIQUE (program_code);


--
-- Name: records records_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.records
    ADD CONSTRAINT records_pkey PRIMARY KEY (attendance_id);


--
-- Name: records records_student_id_timetable_id_attendance_date_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.records
    ADD CONSTRAINT records_student_id_timetable_id_attendance_date_key UNIQUE (student_id, timetable_id, attendance_date);


--
-- Name: registration_images registration_images_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.registration_images
    ADD CONSTRAINT registration_images_pkey PRIMARY KEY (image_id);


--
-- Name: registration_sessions registration_sessions_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.registration_sessions
    ADD CONSTRAINT registration_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: report_exports report_exports_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.report_exports
    ADD CONSTRAINT report_exports_pkey PRIMARY KEY (export_id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (role_id);


--
-- Name: roles roles_role_name_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.roles
    ADD CONSTRAINT roles_role_name_key UNIQUE (role_name);


--
-- Name: sections sections_department_id_program_id_academic_year_id_semester_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.sections
    ADD CONSTRAINT sections_department_id_program_id_academic_year_id_semester_key UNIQUE (department_id, program_id, academic_year_id, semester_id, section_name);


--
-- Name: sections sections_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.sections
    ADD CONSTRAINT sections_pkey PRIMARY KEY (section_id);


--
-- Name: semesters semesters_academic_year_id_semester_no_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.semesters
    ADD CONSTRAINT semesters_academic_year_id_semester_no_key UNIQUE (academic_year_id, semester_no);


--
-- Name: semesters semesters_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.semesters
    ADD CONSTRAINT semesters_pkey PRIMARY KEY (semester_id);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (staff_id);


--
-- Name: staff_sections staff_sections_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_sections
    ADD CONSTRAINT staff_sections_pkey PRIMARY KEY (staff_section_id);


--
-- Name: staff_sections staff_sections_staff_id_section_id_role_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_sections
    ADD CONSTRAINT staff_sections_staff_id_section_id_role_key UNIQUE (staff_id, section_id, role);


--
-- Name: staff staff_staff_code_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff
    ADD CONSTRAINT staff_staff_code_key UNIQUE (staff_code);


--
-- Name: staff_subjects staff_subjects_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_subjects
    ADD CONSTRAINT staff_subjects_pkey PRIMARY KEY (staff_subject_id);


--
-- Name: staff_subjects staff_subjects_staff_id_subject_id_academic_year_id_semeste_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_subjects
    ADD CONSTRAINT staff_subjects_staff_id_subject_id_academic_year_id_semeste_key UNIQUE (staff_id, subject_id, academic_year_id, semester_id);


--
-- Name: staff staff_user_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff
    ADD CONSTRAINT staff_user_id_key UNIQUE (user_id);


--
-- Name: status_history status_history_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.status_history
    ADD CONSTRAINT status_history_pkey PRIMARY KEY (history_id);


--
-- Name: student_parents student_parents_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.student_parents
    ADD CONSTRAINT student_parents_pkey PRIMARY KEY (parent_id);


--
-- Name: subject_categories subject_categories_category_name_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_categories
    ADD CONSTRAINT subject_categories_category_name_key UNIQUE (category_name);


--
-- Name: subject_categories subject_categories_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_categories
    ADD CONSTRAINT subject_categories_pkey PRIMARY KEY (category_id);


--
-- Name: subject_summary subject_summary_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_summary
    ADD CONSTRAINT subject_summary_pkey PRIMARY KEY (summary_id);


--
-- Name: subject_summary subject_summary_student_id_subject_id_semester_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_summary
    ADD CONSTRAINT subject_summary_student_id_subject_id_semester_id_key UNIQUE (student_id, subject_id, semester_id);


--
-- Name: subjects subjects_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (subject_id);


--
-- Name: subjects subjects_subject_code_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subjects
    ADD CONSTRAINT subjects_subject_code_key UNIQUE (subject_code);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (setting_key);


--
-- Name: timetable_history timetable_history_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable_history
    ADD CONSTRAINT timetable_history_pkey PRIMARY KEY (history_id);


--
-- Name: timetable timetable_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_pkey PRIMARY KEY (timetable_id);


--
-- Name: unknown_reviews unknown_reviews_detection_id_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.unknown_reviews
    ADD CONSTRAINT unknown_reviews_detection_id_key UNIQUE (detection_id);


--
-- Name: unknown_reviews unknown_reviews_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.unknown_reviews
    ADD CONSTRAINT unknown_reviews_pkey PRIMARY KEY (review_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: user_sessions user_sessions_session_token_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.user_sessions
    ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: working_days working_days_academic_year_id_work_date_key; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.working_days
    ADD CONSTRAINT working_days_academic_year_id_work_date_key UNIQUE (academic_year_id, work_date);


--
-- Name: working_days working_days_pkey; Type: CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.working_days
    ADD CONSTRAINT working_days_pkey PRIMARY KEY (working_day_id);


--
-- Name: cameras cameras_pkey; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.cameras
    ADD CONSTRAINT cameras_pkey PRIMARY KEY (camera_id);


--
-- Name: face_embeddings face_embeddings_pkey; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.face_embeddings
    ADD CONSTRAINT face_embeddings_pkey PRIMARY KEY (embedding_id);


--
-- Name: identification_events identification_events_pkey; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.identification_events
    ADD CONSTRAINT identification_events_pkey PRIMARY KEY (event_id);


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (student_id);


--
-- Name: students students_register_no_key; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.students
    ADD CONSTRAINT students_register_no_key UNIQUE (register_no);


--
-- Name: students students_university_id_key; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.students
    ADD CONSTRAINT students_university_id_key UNIQUE (university_id);


--
-- Name: students students_user_id_key; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.students
    ADD CONSTRAINT students_user_id_key UNIQUE (user_id);


--
-- Name: unresolved_detections unresolved_detections_pkey; Type: CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.unresolved_detections
    ADD CONSTRAINT unresolved_detections_pkey PRIMARY KEY (detection_id);


--
-- Name: records_date_idx; Type: INDEX; Schema: attendance; Owner: postgres
--

CREATE INDEX records_date_idx ON attendance.records USING btree (attendance_date);


--
-- Name: records_student_idx; Type: INDEX; Schema: attendance; Owner: postgres
--

CREATE INDEX records_student_idx ON attendance.records USING btree (student_id);


--
-- Name: timetable_active_slot_idx; Type: INDEX; Schema: attendance; Owner: postgres
--

CREATE UNIQUE INDEX timetable_active_slot_idx ON attendance.timetable USING btree (section_id, day_of_week, period_id) WHERE is_active;


--
-- Name: face_embeddings_model_version_idx; Type: INDEX; Schema: identity; Owner: postgres
--

CREATE INDEX face_embeddings_model_version_idx ON identity.face_embeddings USING btree (model_version);


--
-- Name: face_embeddings_student_idx; Type: INDEX; Schema: identity; Owner: postgres
--

CREATE INDEX face_embeddings_student_idx ON identity.face_embeddings USING btree (student_id);


--
-- Name: identification_events_student_time_idx; Type: INDEX; Schema: identity; Owner: postgres
--

CREATE INDEX identification_events_student_time_idx ON identity.identification_events USING btree (student_id, frame_captured_at DESC);


--
-- Name: identification_events_unconsumed_idx; Type: INDEX; Schema: identity; Owner: postgres
--

CREATE INDEX identification_events_unconsumed_idx ON identity.identification_events USING btree (matched_at) WHERE (NOT consumed);


--
-- Name: unresolved_detections_stage_idx; Type: INDEX; Schema: identity; Owner: postgres
--

CREATE INDEX unresolved_detections_stage_idx ON identity.unresolved_detections USING btree (stage);


--
-- Name: unresolved_detections_time_idx; Type: INDEX; Schema: identity; Owner: postgres
--

CREATE INDEX unresolved_detections_time_idx ON identity.unresolved_detections USING btree (frame_captured_at DESC);


--
-- Name: records trg_attendance_status_history; Type: TRIGGER; Schema: attendance; Owner: postgres
--

CREATE TRIGGER trg_attendance_status_history AFTER UPDATE ON attendance.records FOR EACH ROW EXECUTE FUNCTION attendance.log_status_change();


--
-- Name: face_embeddings trg_face_registered; Type: TRIGGER; Schema: identity; Owner: postgres
--

CREATE TRIGGER trg_face_registered AFTER INSERT ON identity.face_embeddings FOR EACH ROW EXECUTE FUNCTION identity.mark_face_registered();


--
-- Name: alerts alerts_semester_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.alerts
    ADD CONSTRAINT alerts_semester_id_fkey FOREIGN KEY (semester_id) REFERENCES attendance.semesters(semester_id);


--
-- Name: alerts alerts_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.alerts
    ADD CONSTRAINT alerts_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id);


--
-- Name: alerts alerts_subject_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.alerts
    ADD CONSTRAINT alerts_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES attendance.subjects(subject_id);


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES attendance.users(user_id);


--
-- Name: camera_health_logs camera_health_logs_camera_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.camera_health_logs
    ADD CONSTRAINT camera_health_logs_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES identity.cameras(camera_id) ON DELETE CASCADE;


--
-- Name: class_swaps class_swaps_approved_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.class_swaps
    ADD CONSTRAINT class_swaps_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES attendance.users(user_id);


--
-- Name: class_swaps class_swaps_original_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.class_swaps
    ADD CONSTRAINT class_swaps_original_staff_id_fkey FOREIGN KEY (original_staff_id) REFERENCES attendance.staff(staff_id);


--
-- Name: class_swaps class_swaps_replacement_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.class_swaps
    ADD CONSTRAINT class_swaps_replacement_staff_id_fkey FOREIGN KEY (replacement_staff_id) REFERENCES attendance.staff(staff_id);


--
-- Name: class_swaps class_swaps_timetable_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.class_swaps
    ADD CONSTRAINT class_swaps_timetable_id_fkey FOREIGN KEY (timetable_id) REFERENCES attendance.timetable(timetable_id);


--
-- Name: corrections corrections_attendance_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.corrections
    ADD CONSTRAINT corrections_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES attendance.records(attendance_id);


--
-- Name: corrections corrections_corrected_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.corrections
    ADD CONSTRAINT corrections_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES attendance.users(user_id);


--
-- Name: daily_summary daily_summary_department_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.daily_summary
    ADD CONSTRAINT daily_summary_department_id_fkey FOREIGN KEY (department_id) REFERENCES attendance.departments(department_id);


--
-- Name: daily_summary daily_summary_section_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.daily_summary
    ADD CONSTRAINT daily_summary_section_id_fkey FOREIGN KEY (section_id) REFERENCES attendance.sections(section_id);


--
-- Name: departments departments_hod_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.departments
    ADD CONSTRAINT departments_hod_staff_id_fkey FOREIGN KEY (hod_staff_id) REFERENCES attendance.staff(staff_id);


--
-- Name: email_queue email_queue_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.email_queue
    ADD CONSTRAINT email_queue_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id);


--
-- Name: holidays holidays_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.holidays
    ADD CONSTRAINT holidays_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: ingested_events ingested_events_attendance_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.ingested_events
    ADD CONSTRAINT ingested_events_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES attendance.records(attendance_id);


--
-- Name: ingested_events ingested_events_event_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.ingested_events
    ADD CONSTRAINT ingested_events_event_id_fkey FOREIGN KEY (event_id) REFERENCES identity.identification_events(event_id);


--
-- Name: monthly_summary monthly_summary_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.monthly_summary
    ADD CONSTRAINT monthly_summary_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: monthly_summary monthly_summary_department_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.monthly_summary
    ADD CONSTRAINT monthly_summary_department_id_fkey FOREIGN KEY (department_id) REFERENCES attendance.departments(department_id);


--
-- Name: monthly_summary monthly_summary_section_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.monthly_summary
    ADD CONSTRAINT monthly_summary_section_id_fkey FOREIGN KEY (section_id) REFERENCES attendance.sections(section_id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES attendance.users(user_id) ON DELETE CASCADE;


--
-- Name: records records_marked_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.records
    ADD CONSTRAINT records_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES attendance.users(user_id);


--
-- Name: records records_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.records
    ADD CONSTRAINT records_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id);


--
-- Name: records records_timetable_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.records
    ADD CONSTRAINT records_timetable_id_fkey FOREIGN KEY (timetable_id) REFERENCES attendance.timetable(timetable_id);


--
-- Name: registration_images registration_images_session_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.registration_images
    ADD CONSTRAINT registration_images_session_id_fkey FOREIGN KEY (session_id) REFERENCES attendance.registration_sessions(session_id) ON DELETE CASCADE;


--
-- Name: registration_images registration_images_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.registration_images
    ADD CONSTRAINT registration_images_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id) ON DELETE CASCADE;


--
-- Name: registration_sessions registration_sessions_registered_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.registration_sessions
    ADD CONSTRAINT registration_sessions_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES attendance.users(user_id);


--
-- Name: registration_sessions registration_sessions_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.registration_sessions
    ADD CONSTRAINT registration_sessions_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id) ON DELETE CASCADE;


--
-- Name: report_exports report_exports_exported_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.report_exports
    ADD CONSTRAINT report_exports_exported_by_fkey FOREIGN KEY (exported_by) REFERENCES attendance.users(user_id);


--
-- Name: sections sections_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.sections
    ADD CONSTRAINT sections_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: sections sections_department_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.sections
    ADD CONSTRAINT sections_department_id_fkey FOREIGN KEY (department_id) REFERENCES attendance.departments(department_id);


--
-- Name: sections sections_program_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.sections
    ADD CONSTRAINT sections_program_id_fkey FOREIGN KEY (program_id) REFERENCES attendance.programs(program_id);


--
-- Name: sections sections_semester_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.sections
    ADD CONSTRAINT sections_semester_id_fkey FOREIGN KEY (semester_id) REFERENCES attendance.semesters(semester_id);


--
-- Name: semesters semesters_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.semesters
    ADD CONSTRAINT semesters_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: staff staff_department_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff
    ADD CONSTRAINT staff_department_id_fkey FOREIGN KEY (department_id) REFERENCES attendance.departments(department_id);


--
-- Name: staff_sections staff_sections_section_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_sections
    ADD CONSTRAINT staff_sections_section_id_fkey FOREIGN KEY (section_id) REFERENCES attendance.sections(section_id) ON DELETE CASCADE;


--
-- Name: staff_sections staff_sections_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_sections
    ADD CONSTRAINT staff_sections_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES attendance.staff(staff_id) ON DELETE CASCADE;


--
-- Name: staff_subjects staff_subjects_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_subjects
    ADD CONSTRAINT staff_subjects_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: staff_subjects staff_subjects_semester_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_subjects
    ADD CONSTRAINT staff_subjects_semester_id_fkey FOREIGN KEY (semester_id) REFERENCES attendance.semesters(semester_id);


--
-- Name: staff_subjects staff_subjects_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_subjects
    ADD CONSTRAINT staff_subjects_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES attendance.staff(staff_id) ON DELETE CASCADE;


--
-- Name: staff_subjects staff_subjects_subject_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff_subjects
    ADD CONSTRAINT staff_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES attendance.subjects(subject_id);


--
-- Name: staff staff_user_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.staff
    ADD CONSTRAINT staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES attendance.users(user_id) ON DELETE CASCADE;


--
-- Name: status_history status_history_modified_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.status_history
    ADD CONSTRAINT status_history_modified_by_fkey FOREIGN KEY (modified_by) REFERENCES attendance.users(user_id);


--
-- Name: status_history status_history_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.status_history
    ADD CONSTRAINT status_history_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id);


--
-- Name: status_history status_history_timetable_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.status_history
    ADD CONSTRAINT status_history_timetable_id_fkey FOREIGN KEY (timetable_id) REFERENCES attendance.timetable(timetable_id);


--
-- Name: student_parents student_parents_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.student_parents
    ADD CONSTRAINT student_parents_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id) ON DELETE CASCADE;


--
-- Name: subject_summary subject_summary_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_summary
    ADD CONSTRAINT subject_summary_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: subject_summary subject_summary_semester_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_summary
    ADD CONSTRAINT subject_summary_semester_id_fkey FOREIGN KEY (semester_id) REFERENCES attendance.semesters(semester_id);


--
-- Name: subject_summary subject_summary_student_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_summary
    ADD CONSTRAINT subject_summary_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id);


--
-- Name: subject_summary subject_summary_subject_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subject_summary
    ADD CONSTRAINT subject_summary_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES attendance.subjects(subject_id);


--
-- Name: subjects subjects_category_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subjects
    ADD CONSTRAINT subjects_category_id_fkey FOREIGN KEY (category_id) REFERENCES attendance.subject_categories(category_id);


--
-- Name: subjects subjects_department_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.subjects
    ADD CONSTRAINT subjects_department_id_fkey FOREIGN KEY (department_id) REFERENCES attendance.departments(department_id);


--
-- Name: timetable timetable_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: timetable timetable_classroom_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_classroom_id_fkey FOREIGN KEY (classroom_id) REFERENCES attendance.classrooms(classroom_id);


--
-- Name: timetable_history timetable_history_modified_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable_history
    ADD CONSTRAINT timetable_history_modified_by_fkey FOREIGN KEY (modified_by) REFERENCES attendance.users(user_id);


--
-- Name: timetable_history timetable_history_new_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable_history
    ADD CONSTRAINT timetable_history_new_staff_id_fkey FOREIGN KEY (new_staff_id) REFERENCES attendance.staff(staff_id);


--
-- Name: timetable_history timetable_history_old_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable_history
    ADD CONSTRAINT timetable_history_old_staff_id_fkey FOREIGN KEY (old_staff_id) REFERENCES attendance.staff(staff_id);


--
-- Name: timetable_history timetable_history_timetable_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable_history
    ADD CONSTRAINT timetable_history_timetable_id_fkey FOREIGN KEY (timetable_id) REFERENCES attendance.timetable(timetable_id);


--
-- Name: timetable timetable_period_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_period_id_fkey FOREIGN KEY (period_id) REFERENCES attendance.periods(period_id);


--
-- Name: timetable timetable_section_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_section_id_fkey FOREIGN KEY (section_id) REFERENCES attendance.sections(section_id);


--
-- Name: timetable timetable_semester_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_semester_id_fkey FOREIGN KEY (semester_id) REFERENCES attendance.semesters(semester_id);


--
-- Name: timetable timetable_staff_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES attendance.staff(staff_id);


--
-- Name: timetable timetable_subject_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.timetable
    ADD CONSTRAINT timetable_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES attendance.subjects(subject_id);


--
-- Name: unknown_reviews unknown_reviews_detection_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.unknown_reviews
    ADD CONSTRAINT unknown_reviews_detection_id_fkey FOREIGN KEY (detection_id) REFERENCES identity.unresolved_detections(detection_id);


--
-- Name: unknown_reviews unknown_reviews_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.unknown_reviews
    ADD CONSTRAINT unknown_reviews_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES attendance.users(user_id);


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES attendance.users(user_id) ON DELETE CASCADE;


--
-- Name: users users_department_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.users
    ADD CONSTRAINT users_department_id_fkey FOREIGN KEY (department_id) REFERENCES attendance.departments(department_id);


--
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES attendance.roles(role_id);


--
-- Name: working_days working_days_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: attendance; Owner: postgres
--

ALTER TABLE ONLY attendance.working_days
    ADD CONSTRAINT working_days_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES attendance.academic_years(academic_year_id);


--
-- Name: cameras cameras_classroom_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.cameras
    ADD CONSTRAINT cameras_classroom_id_fkey FOREIGN KEY (classroom_id) REFERENCES attendance.classrooms(classroom_id);


--
-- Name: face_embeddings face_embeddings_student_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.face_embeddings
    ADD CONSTRAINT face_embeddings_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id) ON DELETE CASCADE;


--
-- Name: identification_events identification_events_camera_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.identification_events
    ADD CONSTRAINT identification_events_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES identity.cameras(camera_id);


--
-- Name: identification_events identification_events_student_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.identification_events
    ADD CONSTRAINT identification_events_student_id_fkey FOREIGN KEY (student_id) REFERENCES identity.students(student_id);


--
-- Name: students students_section_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.students
    ADD CONSTRAINT students_section_id_fkey FOREIGN KEY (section_id) REFERENCES attendance.sections(section_id);


--
-- Name: students students_user_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.students
    ADD CONSTRAINT students_user_id_fkey FOREIGN KEY (user_id) REFERENCES attendance.users(user_id);


--
-- Name: unresolved_detections unresolved_detections_camera_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: postgres
--

ALTER TABLE ONLY identity.unresolved_detections
    ADD CONSTRAINT unresolved_detections_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES identity.cameras(camera_id);


--
-- PostgreSQL database dump complete
--

\unrestrict QuRWcT76G4Faye50oxyzAOlhQqgvZpSou8pfwXCL6yMJm8eAxIz7SBmHjiBQRJw

