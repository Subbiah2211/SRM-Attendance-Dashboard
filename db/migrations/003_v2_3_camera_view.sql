-- =====================================================================
-- SRM attendance schema: v2.2 -> v2.3
--   * a module "AI camera view", open by default to admin, HOD and staff
--   * an optional viewer address per camera, for showing live video
-- =====================================================================

-- A browser cannot play a camera's RTSP stream. viewer_url is the address of something
-- a browser can show: an HLS playlist (.m3u8), an MJPEG stream, or a page of the
-- college's video gateway / NVR. It must not contain a user name or password:
-- source_ref stays the only link to camera credentials, in the secret store.
ALTER TABLE identity.cameras ADD COLUMN viewer_url text;
ALTER TABLE identity.cameras ADD CONSTRAINT cameras_viewer_url_check
    CHECK (viewer_url IS NULL OR viewer_url ~ '^https?://[^@[:space:]]+$');
COMMENT ON COLUMN identity.cameras.viewer_url IS 'Optional http(s) address a browser can show (HLS, MJPEG or a gateway page). No credentials.';

INSERT INTO attendance.modules (module_key, module_name, sort_order)
VALUES ('camera_view', 'AI camera view', 115)
ON CONFLICT (module_key) DO NOTHING;

-- Colleges that already exist get the default: view for admin, HOD and staff; none for students.
INSERT INTO attendance.role_module_permissions (college_id, role_id, module_id, can_view)
SELECT c.college_id, r.role_id, m.module_id, r.role_name IN ('admin', 'hod', 'staff')
  FROM attendance.colleges c
  CROSS JOIN attendance.roles r
  JOIN attendance.modules m ON m.module_key = 'camera_view'
 WHERE r.role_name IN ('admin', 'hod', 'staff', 'student')
ON CONFLICT (college_id, role_id, module_id) DO NOTHING;
