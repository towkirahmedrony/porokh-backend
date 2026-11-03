-- Which HSC group (stream) each admission unit is meant for, so a unit can be
-- found from "institution + group" and a wrong unit/group pairing can be caught.
alter table public.admission_units
  add column if not exists group_type text
  check (group_type in ('science', 'humanities', 'commerce', 'fine_arts', 'all'));

comment on column public.admission_units.group_type is
  'Target HSC group: science | humanities | commerce | fine_arts | all. NULL = not recorded.';

update public.admission_units u
set group_type = m.g
from (values
  ('BRUR','a','science'),('BRUR','b','humanities'),('BRUR','c','commerce'),
  ('BSMRSTU','a','science'),('BSMRSTU','b','humanities'),('BSMRSTU','c','commerce'),
  ('BU','a','science'),('BU','b','humanities'),('BU','c','commerce'),
  ('IU','a','science'),('IU','b','humanities'),('IU','c','commerce'),
  ('JKKNIU','a','science'),('JKKNIU','b','humanities'),('JKKNIU','c','commerce'),
  ('JUST','a','science'),('JUST','b','humanities'),('JUST','c','commerce'),
  ('MBSTU','a','science'),('MBSTU','b','humanities'),('MBSTU','c','commerce'),
  ('NSTU','a','science'),('NSTU','b','humanities'),('NSTU','c','commerce'),
  ('PSTU','a','science'),('PSTU','b','humanities'),('PSTU','c','commerce'),
  ('PUST','a','science'),('PUST','b','humanities'),('PUST','c','commerce'),
  ('RUB','a','science'),('RUB','b','humanities'),('RUB','c','commerce'),
  ('CoU','a','science'),('CoU','b','humanities'),('CoU','c','commerce'),
  ('CU','a','science'),('CU','b','humanities'),('CU','b1','humanities'),
  ('CU','c','commerce'),('CU','d','all'),('CU','d1','all'),
  ('DU','a','science'),('DU','b','humanities'),('DU','c','commerce'),('DU','cha','fine_arts'),
  ('JU','a','science'),('JU','b','humanities'),('JU','c','humanities'),('JU','c1','humanities'),
  ('JU','d','science'),('JU','e','commerce'),
  ('JnU','a','science'),('JnU','b','humanities'),('JnU','c','commerce'),
  ('JnU','d','humanities'),('JnU','e','fine_arts'),
  ('KU','a','science'),('KU','b','science'),('KU','c','humanities'),('KU','d','commerce'),
  ('RU','a','humanities'),('RU','b','commerce'),('RU','c','science')
) as m(inst, code, g), public.institutions i
where i.short_name = m.inst
  and u.institution_id = i.id
  and u.code = m.code
  and u.group_type is null;
