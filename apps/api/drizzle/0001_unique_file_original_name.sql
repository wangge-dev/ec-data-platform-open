DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "public"."data_sources"
    WHERE type = 'file'
      AND NULLIF(config->>'originalFileName', '') IS NOT NULL
    GROUP BY (config->>'originalFileName')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique file original names: duplicate data sources exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX "uq_data_sources_file_original_name"
  ON "public"."data_sources" ((config->>'originalFileName'))
  WHERE type = 'file'
    AND NULLIF(config->>'originalFileName', '') IS NOT NULL;
