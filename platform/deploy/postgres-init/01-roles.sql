-- Least-privilege roles created at first container start.
-- Passwords come from the environment; nothing is baked into the image.
-- The superuser (POSTGRES_USER) is used ONLY for migrations.
\set writer_pw `echo "$LH_WRITER_PASSWORD"`
\set reader_pw `echo "$LH_READER_PASSWORD"`

CREATE ROLE lh_writer LOGIN PASSWORD :'writer_pw' CONNECTION LIMIT 20;
CREATE ROLE lh_reader LOGIN PASSWORD :'reader_pw' CONNECTION LIMIT 10;

-- No role may create objects in public, and none inherits superuser.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"POSTGRES_DB" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"POSTGRES_DB" TO lh_writer, lh_reader;

-- Bound runaway statements per role (defence in depth vs the app's own timeout).
ALTER ROLE lh_writer SET statement_timeout = '30s';
ALTER ROLE lh_reader SET statement_timeout = '60s';
