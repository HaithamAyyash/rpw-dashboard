-- migrate:up

-- A measurement now holds either an MFCC matrix for the server's model, or the result of a model
-- that ran on the node. Exactly one, and a node's result always says which model produced it.
ALTER TABLE acoustic_features ALTER COLUMN mfcc DROP NOT NULL;
ALTER TABLE acoustic_features
  ADD COLUMN confidence real CHECK (confidence BETWEEN 0 AND 1),  -- P(infested), as in classification_results
  ADD COLUMN model_version text CHECK (model_version ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE acoustic_features
  ADD CONSTRAINT acoustic_features_one_payload CHECK ((mfcc IS NULL) <> (confidence IS NULL)),
  ADD CONSTRAINT acoustic_features_result_has_model CHECK ((confidence IS NULL) = (model_version IS NULL));

GRANT INSERT (confidence, model_version) ON acoustic_features TO nakhel_web;

-- migrate:down

-- A matrix can't be recovered, so rows without one have to go, along with their results.
DELETE FROM classification_results c USING acoustic_features f
  WHERE f.node_id = c.node_id AND f."timestamp" = c."timestamp" AND f.mfcc IS NULL;
DELETE FROM acoustic_features WHERE mfcc IS NULL;

ALTER TABLE acoustic_features
  DROP CONSTRAINT acoustic_features_one_payload,
  DROP CONSTRAINT acoustic_features_result_has_model,
  DROP COLUMN confidence,
  DROP COLUMN model_version;
ALTER TABLE acoustic_features ALTER COLUMN mfcc SET NOT NULL;
