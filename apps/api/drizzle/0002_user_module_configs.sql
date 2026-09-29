CREATE TABLE public.module_configs (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  category VARCHAR(64),
  description TEXT NOT NULL,
  config JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  origin VARCHAR(32) NOT NULL CHECK (origin IN ('user', 'builtin_overlay')),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by BIGINT NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE public.module_config_versions (
  id BIGSERIAL PRIMARY KEY,
  module_code VARCHAR(64) NOT NULL,
  version INTEGER NOT NULL,
  config JSONB NOT NULL,
  created_by BIGINT NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (module_code, version)
);

CREATE TABLE public.module_schema_decisions (
  id BIGSERIAL PRIMARY KEY,
  module_code VARCHAR(64) NOT NULL,
  source_field VARCHAR(256) NOT NULL,
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('add', 'alias', 'ignore')),
  target_field VARCHAR(64),
  data_type VARCHAR(16),
  created_by BIGINT NOT NULL REFERENCES public.users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (module_code, source_field)
);
