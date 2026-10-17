-- Optional JSON for external R2 events: eventTime, object eTag, and copySource.
ALTER TABLE audit_log ADD COLUMN detail TEXT;
