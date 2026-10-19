-- Lookups that every write runs read the whole table without these: a note's chunks (delete,
-- ids, next chunk number), the open links a new note can resolve, the links that point at a
-- note, and a note's journal entries. The audit log is read by time and by request id.
CREATE INDEX chunks_note ON chunks(note_id, n);
CREATE INDEX links_target_open ON links(target) WHERE dst_note_id IS NULL;
CREATE INDEX links_dst ON links(dst_note_id) WHERE dst_note_id IS NOT NULL;
CREATE INDEX journal_entries_note ON journal_entries(note_id);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE INDEX audit_log_request ON audit_log(request_id);
