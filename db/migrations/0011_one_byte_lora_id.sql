-- migrate:up

-- The node ID in the LoRa packet is 1 byte (team decision, DECISIONS.md N8), so at most 256 nodes
-- per cluster head. Fails on a database holding larger IDs, by design: those nodes could never
-- have transmitted them, so they need correcting rather than silently keeping.
ALTER TABLE nodes DROP CONSTRAINT nodes_lora_id_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_lora_id_check CHECK (lora_id BETWEEN 0 AND 255);

-- migrate:down
ALTER TABLE nodes DROP CONSTRAINT nodes_lora_id_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_lora_id_check CHECK (lora_id BETWEEN 0 AND 65535);
