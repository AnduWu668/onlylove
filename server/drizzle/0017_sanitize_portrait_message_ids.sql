CREATE FUNCTION onlylove_clean_portrait_text(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT NULLIF(
    BTRIM(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          value,
          '[[:space:]]*[（(]?[[:space:]]*[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[[:space:]]*[）)]?',
          '',
          'gi'
        ),
        '[[:space:]]*[,，、;；]+[[:space:]]*([。！？!?]|$)',
        E'\\1',
        'g'
      )
    ),
    ''
  );
$$;
--> statement-breakpoint
CREATE FUNCTION onlylove_clean_portrait_dimensions(content jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  result jsonb := content;
  dimension_key text;
  field_key text;
  text_value text;
  cleaned_value text;
  cleaned_contradictions jsonb;
BEGIN
  FOREACH dimension_key IN ARRAY ARRAY[
    'long_term_planning',
    'values',
    'relationship_boundaries',
    'communication',
    'conflict_repair',
    'emotional_support',
    'lifestyle',
    'family_and_finance'
  ] LOOP
    FOREACH field_key IN ARRAY ARRAY[
      'selfTendency',
      'partnerExpectation',
      'hardBoundary'
    ] LOOP
      text_value := result #>> ARRAY[dimension_key, field_key];
      IF text_value IS NOT NULL THEN
        cleaned_value := onlylove_clean_portrait_text(text_value);
        result := jsonb_set(
          result,
          ARRAY[dimension_key, field_key],
          CASE
            WHEN cleaned_value IS NULL THEN 'null'::jsonb
            ELSE to_jsonb(cleaned_value)
          END,
          false
        );
      END IF;
    END LOOP;

    SELECT COALESCE(jsonb_agg(to_jsonb(cleaned)), '[]'::jsonb)
      INTO cleaned_contradictions
      FROM (
        SELECT onlylove_clean_portrait_text(item) AS cleaned
          FROM jsonb_array_elements_text(
            COALESCE(
              result #> ARRAY[dimension_key, 'contradictions'],
              '[]'::jsonb
            )
          ) AS item
      ) AS values
     WHERE cleaned IS NOT NULL;
    result := jsonb_set(
      result,
      ARRAY[dimension_key, 'contradictions'],
      cleaned_contradictions,
      false
    );
  END LOOP;

  RETURN result;
END;
$$;
--> statement-breakpoint
UPDATE portrait_drafts
   SET content = onlylove_clean_portrait_dimensions(content);
--> statement-breakpoint
UPDATE portrait_versions
   SET match_profile = jsonb_set(
         match_profile,
         '{dimensions}',
         onlylove_clean_portrait_dimensions(match_profile -> 'dimensions'),
         false
       ),
       persona_context = COALESCE(
         onlylove_clean_portrait_text(persona_context),
         ''
       );
--> statement-breakpoint
DROP FUNCTION onlylove_clean_portrait_dimensions(jsonb);
--> statement-breakpoint
DROP FUNCTION onlylove_clean_portrait_text(text);
