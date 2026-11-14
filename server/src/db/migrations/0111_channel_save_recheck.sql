-- A transfer into the vault or a share is authorized again when it is saved (docs/transfers.md): the app key the
-- channel was opened through (its cap still narrows the write) and the tool that opened it (channel_open also needs
-- channel.use). Both NULL on channels opened before, which are re-checked without them.
ALTER TABLE data_channels ADD COLUMN from_app_credential_id TEXT REFERENCES credentials(id);
ALTER TABLE data_channels ADD COLUMN opened_with TEXT;
