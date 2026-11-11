-- Least-privilege grants for an application role.
-- Run this as the migration owner after creating a NOLOGIN or password role
-- that is not a superuser and does not have CREATEDB or CREATEROLE.
--
--   CREATE ROLE bidcheckpro_app NOLOGIN;
--   GRANT bidcheckpro_app TO <login role used by the app>;
--   \i db/grants.sql

GRANT USAGE ON SCHEMA public TO bidcheckpro_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON fulfillment_bids, fulfillment_events, schema_migrations
  TO bidcheckpro_app;

-- The application role is not granted CREATE, TRUNCATE, or references on
-- other schemas. It cannot read roles, alter the cluster, or manage files.
