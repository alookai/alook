CREATE TABLE `community_replica_scope_revision` (
  `scope_kind` text NOT NULL,
  `scope_id` text NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`scope_kind`, `scope_id`),
  CONSTRAINT `ck_replica_scope_kind` CHECK (`scope_kind` IN ('account', 'server', 'channel')),
  CONSTRAINT `ck_replica_scope_revision` CHECK (`revision` >= 0)
) WITHOUT ROWID;

CREATE TABLE `community_replica_delta` (
  `scope_kind` text NOT NULL,
  `scope_id` text NOT NULL,
  `revision` integer NOT NULL,
  `causal_id` text NOT NULL,
  `committed_at` text NOT NULL,
  `descriptor` text NOT NULL,
  PRIMARY KEY (`scope_kind`, `scope_id`, `revision`),
  CONSTRAINT `ck_replica_delta_scope_kind` CHECK (`scope_kind` IN ('account', 'server', 'channel')),
  CONSTRAINT `ck_replica_delta_revision` CHECK (`revision` > 0),
  CONSTRAINT `ck_replica_delta_descriptor` CHECK (json_valid(`descriptor`))
) WITHOUT ROWID;

CREATE INDEX `idx_replica_delta_causal`
  ON `community_replica_delta` (`causal_id`, `scope_kind`, `scope_id`);

CREATE TABLE `community_replica_intent` (
  `actor_id` text NOT NULL,
  `intent_id` text NOT NULL,
  `request_hash` text NOT NULL,
  `status` text NOT NULL,
  `causal_id` text,
  `channel_id` text NOT NULL,
  `message_id` text,
  `revision` integer,
  `seq` integer,
  `reason` text,
  `rejection_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`actor_id`, `intent_id`),
  FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `ck_replica_intent_status` CHECK (`status` IN ('accepted', 'transformed', 'rejected')),
  CONSTRAINT `ck_replica_intent_outcome` CHECK (
    (`status` IN ('accepted', 'transformed')
      AND `causal_id` IS NOT NULL
      AND `message_id` IS NOT NULL
      AND `revision` > 0
      AND `seq` > 0
      AND `rejection_code` IS NULL)
    OR
    (`status` = 'rejected'
      AND `causal_id` IS NULL
      AND `message_id` IS NULL
      AND `revision` IS NULL
      AND `seq` IS NULL
      AND `rejection_code` IN ('permission-denied', 'target-not-found', 'invalid', 'conflict'))
  )
) WITHOUT ROWID;

CREATE INDEX `idx_replica_intent_message`
  ON `community_replica_intent` (`actor_id`, `message_id`);

CREATE TRIGGER `replica_server_update`
AFTER UPDATE OF `name`, `discriminator`, `description`, `icon`, `owner_id` ON `community_server`
BEGIN
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  VALUES ('server', NEW.`id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET
    `revision` = `community_replica_scope_revision`.`revision` + 1,
    `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', `user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_server_member` WHERE `server_id` = NEW.`id`
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET
    `revision` = `community_replica_scope_revision`.`revision` + 1,
    `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_category_insert` AFTER INSERT ON `community_category` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_category_update` AFTER UPDATE ON `community_category` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_category_delete` BEFORE DELETE ON `community_category` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', OLD.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_channel_insert` AFTER INSERT ON `community_channel` WHEN NEW.`server_id` IS NOT NULL BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_channel_update` AFTER UPDATE ON `community_channel` WHEN NEW.`server_id` IS NOT NULL BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_channel_delete` BEFORE DELETE ON `community_channel` WHEN OLD.`server_id` IS NOT NULL BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', OLD.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_server_member_insert` AFTER INSERT ON `community_server_member` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_server_member_update` AFTER UPDATE ON `community_server_member` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_server_member_delete` BEFORE DELETE ON `community_server_member` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', OLD.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_scope_revision` VALUES ('account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_channel_member_insert` AFTER INSERT ON `community_channel_member` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_channel_member_delete` BEFORE DELETE ON `community_channel_member` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_message_insert` AFTER INSERT ON `community_message` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('channel', NEW.`channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', NEW.`channel_id`, `revision`, 'message:' || NEW.`id`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', NEW.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'channel' AND `scope_id` = NEW.`channel_id`;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', `user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_server_member`
  WHERE `server_id` = (SELECT `server_id` FROM `community_channel` WHERE `id` = NEW.`channel_id`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_message_update` AFTER UPDATE ON `community_message` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('channel', NEW.`channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', NEW.`channel_id`, `revision`, 'message-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', NEW.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'channel' AND `scope_id` = NEW.`channel_id`;
END;

CREATE TRIGGER `replica_message_delete` BEFORE DELETE ON `community_message` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('channel', OLD.`channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', OLD.`channel_id`, `revision`, 'message-delete:' || OLD.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'message-remove', 'messageId', OLD.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'channel' AND `scope_id` = OLD.`channel_id`;
END;

CREATE TRIGGER `replica_read_state_insert` AFTER INSERT ON `community_read_state` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, NEW.`last_read_at`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_read_state_update` AFTER UPDATE ON `community_read_state` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, NEW.`last_read_at`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_read_state_delete` BEFORE DELETE ON `community_read_state` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;

CREATE TRIGGER `replica_mention_insert` AFTER INSERT ON `community_mention` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_mention_update` AFTER UPDATE ON `community_mention` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
CREATE TRIGGER `replica_mention_delete` BEFORE DELETE ON `community_mention` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
END;
