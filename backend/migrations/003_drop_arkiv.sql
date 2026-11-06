-- Arkiv removed: agents no longer have an Arkiv AgentLink entity.
alter table agents drop column if exists arkiv_key;
