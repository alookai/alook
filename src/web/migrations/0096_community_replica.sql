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
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`id`, `revision`, 'server-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'server-metadata-refresh', 'serverId', NEW.`id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`id`;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', `user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_server_member` WHERE `server_id` = NEW.`id`
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET
    `revision` = `community_replica_scope_revision`.`revision` + 1,
    `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', member.`user_id`, account_scope.`revision`, 'server-update:' || NEW.`id` || ':' || server_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', NEW.`id`)
  FROM `community_server_member` AS member
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = member.`user_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = NEW.`id`
  WHERE member.`server_id` = NEW.`id`;
END;

CREATE TRIGGER `replica_category_insert` AFTER INSERT ON `community_category` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`server_id`, `revision`, 'category:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'category-refresh', 'categoryId', NEW.`id`, 'reconcileChannels', 0)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`server_id`;
END;
CREATE TRIGGER `replica_category_update` AFTER UPDATE ON `community_category` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`server_id`, `revision`, 'category-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'category-refresh', 'categoryId', NEW.`id`, 'reconcileChannels', OLD.`private` IS NOT NEW.`private`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`server_id`;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', member.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_server_member` AS member
  WHERE member.`server_id` = NEW.`server_id` AND OLD.`private` IS NOT NEW.`private`
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET
    `revision` = `community_replica_scope_revision`.`revision` + 1,
    `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', member.`user_id`, account_scope.`revision`, 'category-update:' || NEW.`id` || ':' || server_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', NEW.`server_id`)
  FROM `community_server_member` AS member
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = member.`user_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = NEW.`server_id`
  WHERE member.`server_id` = NEW.`server_id` AND OLD.`private` IS NOT NEW.`private`;
END;
CREATE TRIGGER `replica_category_delete` BEFORE DELETE ON `community_category` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', OLD.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', OLD.`server_id`, `revision`, 'category-delete:' || OLD.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'category-remove', 'categoryId', OLD.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'server' AND `scope_id` = OLD.`server_id`;
END;

CREATE TRIGGER `replica_channel_insert` AFTER INSERT ON `community_channel` WHEN NEW.`server_id` IS NOT NULL BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.`parent_channel_id` IS NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`server_id`, `revision`, 'channel:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'channel-refresh', 'channelId', NEW.`id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`server_id` AND NEW.`parent_channel_id` IS NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', NEW.`parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.`parent_channel_id` IS NOT NULL AND NEW.`parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', NEW.`parent_channel_id`, `revision`, 'thread:' || NEW.`id`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', NEW.`parent_message_id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'channel' AND `scope_id` = NEW.`parent_channel_id` AND NEW.`parent_message_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_channel_update`
AFTER UPDATE OF `server_id`, `category_id`, `name`, `type`, `topic`, `position`, `parent_channel_id`, `creator_id`, `archived`, `parent_message_id`
ON `community_channel` WHEN NEW.`server_id` IS NOT NULL BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.`parent_channel_id` IS NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`server_id`, `revision`, 'channel-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'channel-refresh', 'channelId', NEW.`id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`server_id` AND NEW.`parent_channel_id` IS NULL;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', member.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_server_member` AS member
  WHERE member.`server_id` = NEW.`server_id`
    AND NEW.`parent_channel_id` IS NULL
    AND (OLD.`category_id` IS NOT NEW.`category_id` OR OLD.`creator_id` IS NOT NEW.`creator_id`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET
    `revision` = `community_replica_scope_revision`.`revision` + 1,
    `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', member.`user_id`, account_scope.`revision`, 'channel-update:' || NEW.`id` || ':' || server_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', NEW.`server_id`)
  FROM `community_server_member` AS member
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = member.`user_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = NEW.`server_id`
  WHERE member.`server_id` = NEW.`server_id`
    AND NEW.`parent_channel_id` IS NULL
    AND (OLD.`category_id` IS NOT NEW.`category_id` OR OLD.`creator_id` IS NOT NEW.`creator_id`);
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', NEW.`parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.`parent_channel_id` IS NOT NULL AND NEW.`parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', NEW.`parent_channel_id`, `revision`, 'thread-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', NEW.`parent_message_id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'channel' AND `scope_id` = NEW.`parent_channel_id` AND NEW.`parent_message_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_channel_delete` BEFORE DELETE ON `community_channel` WHEN OLD.`server_id` IS NOT NULL BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', OLD.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE OLD.`parent_channel_id` IS NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', OLD.`server_id`, `revision`, 'channel-delete:' || OLD.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'channel-remove', 'channelId', OLD.`id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'server' AND `scope_id` = OLD.`server_id` AND OLD.`parent_channel_id` IS NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', OLD.`parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE OLD.`parent_channel_id` IS NOT NULL AND OLD.`parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', OLD.`parent_channel_id`, `revision`, 'thread-delete:' || OLD.`id`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', OLD.`parent_message_id`)
  FROM `community_replica_scope_revision`
  WHERE `scope_kind` = 'channel' AND `scope_id` = OLD.`parent_channel_id` AND OLD.`parent_message_id` IS NOT NULL;
END;

CREATE TRIGGER `replica_server_member_insert` AFTER INSERT ON `community_server_member` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`server_id`, `revision`, 'server-member:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'server-membership-refresh', 'userId', NEW.`user_id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`server_id`;
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'server-member:' || NEW.`id` || ':' || server_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', NEW.`server_id`)
  FROM `community_replica_scope_revision` AS account_scope
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = NEW.`server_id`
  WHERE account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`;
END;
CREATE TRIGGER `replica_server_member_update` AFTER UPDATE ON `community_server_member` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', NEW.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', NEW.`server_id`, `revision`, 'server-member-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'server-membership-refresh', 'userId', NEW.`user_id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'server' AND `scope_id` = NEW.`server_id`;
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'server-member-update:' || NEW.`id` || ':' || server_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', NEW.`server_id`)
  FROM `community_replica_scope_revision` AS account_scope
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = NEW.`server_id`
  WHERE account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`;
END;
CREATE TRIGGER `replica_server_member_delete` BEFORE DELETE ON `community_server_member` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('server', OLD.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', OLD.`server_id`, `revision`, 'server-member-delete:' || OLD.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'server-membership-refresh', 'userId', OLD.`user_id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'server' AND `scope_id` = OLD.`server_id`;
  INSERT INTO `community_replica_scope_revision` VALUES ('account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', OLD.`user_id`, account_scope.`revision`, 'server-member-delete:' || OLD.`id` || ':' || server_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', OLD.`server_id`)
  FROM `community_replica_scope_revision` AS account_scope
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = OLD.`server_id`
  WHERE account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = OLD.`user_id`;
END;

CREATE TRIGGER `replica_channel_member_insert` AFTER INSERT ON `community_channel_member` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, scope.`revision`, 'channel-member:' || NEW.`id`, scope.`updated_at`, json_object(
    'kind', CASE WHEN channel.`parent_channel_id` IS NULL THEN 'channel-refresh' ELSE 'unread-source-refresh' END,
    'channelId', channel.`id`
  )
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS scope ON scope.`scope_kind` = 'server' AND scope.`scope_id` = channel.`server_id`
  WHERE channel.`id` = NEW.`channel_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'channel-member:' || NEW.`id`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', channel.`server_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE channel.`id` = NEW.`channel_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', `parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `parent_channel_id` IS NOT NULL AND `parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', child.`parent_channel_id`, scope.`revision`, 'channel-member:' || NEW.`id`, scope.`updated_at`, json_object('kind', 'message-upsert', 'messageId', child.`parent_message_id`)
  FROM `community_channel` AS child
  JOIN `community_replica_scope_revision` AS scope ON scope.`scope_kind` = 'channel' AND scope.`scope_id` = child.`parent_channel_id`
  WHERE child.`id` = NEW.`channel_id` AND child.`parent_message_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_channel_member_delete` BEFORE DELETE ON `community_channel_member` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, scope.`revision`, 'channel-member-delete:' || OLD.`id`, scope.`updated_at`, json_object(
    'kind', CASE WHEN channel.`parent_channel_id` IS NULL THEN 'channel-refresh' ELSE 'unread-source-refresh' END,
    'channelId', channel.`id`
  )
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS scope ON scope.`scope_kind` = 'server' AND scope.`scope_id` = channel.`server_id`
  WHERE channel.`id` = OLD.`channel_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', OLD.`user_id`, account_scope.`revision`, 'channel-member-delete:' || OLD.`id`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', channel.`server_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = OLD.`user_id`
  WHERE channel.`id` = OLD.`channel_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', `parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `parent_channel_id` IS NOT NULL AND `parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', child.`parent_channel_id`, scope.`revision`, 'channel-member-delete:' || OLD.`id`, scope.`updated_at`, json_object('kind', 'message-upsert', 'messageId', child.`parent_message_id`)
  FROM `community_channel` AS child
  JOIN `community_replica_scope_revision` AS scope ON scope.`scope_kind` = 'channel' AND scope.`scope_id` = child.`parent_channel_id`
  WHERE child.`id` = OLD.`channel_id` AND child.`parent_message_id` IS NOT NULL;
END;

CREATE TRIGGER `replica_message_insert` AFTER INSERT ON `community_message` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('channel', NEW.`channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', NEW.`channel_id`, `revision`, 'message:' || NEW.`id`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', NEW.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'channel' AND `scope_id` = NEW.`channel_id`;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', `parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `parent_channel_id` IS NOT NULL AND `parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', child.`parent_channel_id`, scope.`revision`, 'message:' || NEW.`id`, scope.`updated_at`, json_object('kind', 'message-upsert', 'messageId', child.`parent_message_id`)
  FROM `community_channel` AS child
  JOIN `community_replica_scope_revision` AS scope ON scope.`scope_kind` = 'channel' AND scope.`scope_id` = child.`parent_channel_id`
  WHERE child.`id` = NEW.`channel_id` AND child.`parent_message_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, scope.`revision`, 'message:' || NEW.`id`, scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', NEW.`channel_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS scope ON scope.`scope_kind` = 'server' AND scope.`scope_id` = channel.`server_id`
  WHERE channel.`id` = NEW.`channel_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', `user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_server_member`
  WHERE `server_id` = (SELECT `server_id` FROM `community_channel` WHERE `id` = NEW.`channel_id`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', member.`user_id`, account_scope.`revision`, 'message:' || NEW.`id`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', member.`server_id`)
  FROM `community_server_member` AS member
  JOIN `community_channel` AS channel ON channel.`server_id` = member.`server_id` AND channel.`id` = NEW.`channel_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = member.`user_id`;
END;

CREATE TRIGGER `replica_message_update` AFTER UPDATE ON `community_message` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('channel', NEW.`channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', NEW.`channel_id`, `revision`, 'message-update:' || NEW.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'message-upsert', 'messageId', NEW.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'channel' AND `scope_id` = NEW.`channel_id`;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', `parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `parent_channel_id` IS NOT NULL AND `parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', child.`parent_channel_id`, parent_scope.`revision`, 'message-update:' || NEW.`id` || ':' || child_scope.`revision`, parent_scope.`updated_at`, json_object('kind', 'message-upsert', 'messageId', child.`parent_message_id`)
  FROM `community_channel` AS child
  JOIN `community_replica_scope_revision` AS child_scope ON child_scope.`scope_kind` = 'channel' AND child_scope.`scope_id` = NEW.`channel_id`
  JOIN `community_replica_scope_revision` AS parent_scope ON parent_scope.`scope_kind` = 'channel' AND parent_scope.`scope_id` = child.`parent_channel_id`
  WHERE child.`id` = NEW.`channel_id` AND child.`parent_message_id` IS NOT NULL;
END;

CREATE TRIGGER `replica_message_delete` BEFORE DELETE ON `community_message` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('channel', OLD.`channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', OLD.`channel_id`, `revision`, 'message-delete:' || OLD.`id` || ':' || `revision`, `updated_at`, json_object('kind', 'message-remove', 'messageId', OLD.`id`)
  FROM `community_replica_scope_revision` WHERE `scope_kind` = 'channel' AND `scope_id` = OLD.`channel_id`;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'channel', `parent_channel_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `parent_channel_id` IS NOT NULL AND `parent_message_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'channel', child.`parent_channel_id`, parent_scope.`revision`, 'message-delete:' || OLD.`id` || ':' || child_scope.`revision`, parent_scope.`updated_at`, json_object('kind', 'message-upsert', 'messageId', child.`parent_message_id`)
  FROM `community_channel` AS child
  JOIN `community_replica_scope_revision` AS child_scope ON child_scope.`scope_kind` = 'channel' AND child_scope.`scope_id` = OLD.`channel_id`
  JOIN `community_replica_scope_revision` AS parent_scope ON parent_scope.`scope_kind` = 'channel' AND parent_scope.`scope_id` = child.`parent_channel_id`
  WHERE child.`id` = OLD.`channel_id` AND child.`parent_message_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'message-delete:' || OLD.`id` || ':' || channel_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', OLD.`channel_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS channel_scope ON channel_scope.`scope_kind` = 'channel' AND channel_scope.`scope_id` = OLD.`channel_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  WHERE channel.`id` = OLD.`channel_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision` (`scope_kind`, `scope_id`, `revision`, `updated_at`)
  SELECT 'account', member.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_server_member` AS member
  JOIN `community_channel` AS channel ON channel.`server_id` = member.`server_id`
  WHERE channel.`id` = OLD.`channel_id`
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', member.`user_id`, account_scope.`revision`, 'message-delete:' || OLD.`id` || ':' || channel_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', member.`server_id`)
  FROM `community_server_member` AS member
  JOIN `community_channel` AS channel ON channel.`server_id` = member.`server_id` AND channel.`id` = OLD.`channel_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = member.`user_id`
  JOIN `community_replica_scope_revision` AS channel_scope ON channel_scope.`scope_kind` = 'channel' AND channel_scope.`scope_id` = OLD.`channel_id`;
END;

CREATE TRIGGER `replica_read_state_insert` AFTER INSERT ON `community_read_state` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, NEW.`last_read_at`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'read-state:' || NEW.`id` || ':' || account_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'read-state-refresh', 'channelId', NEW.`channel_id`, 'serverId', channel.`server_id`)
  FROM `community_replica_scope_revision` AS account_scope
  LEFT JOIN `community_channel` AS channel ON channel.`id` = NEW.`channel_id`
  WHERE account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, NEW.`last_read_at` FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'read-state:' || NEW.`id` || ':' || account_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', NEW.`channel_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE channel.`id` = NEW.`channel_id` AND channel.`server_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_read_state_update` AFTER UPDATE ON `community_read_state` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', NEW.`user_id`, 1, NEW.`last_read_at`)
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'read-state-update:' || NEW.`id` || ':' || account_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'read-state-refresh', 'channelId', NEW.`channel_id`, 'serverId', channel.`server_id`)
  FROM `community_replica_scope_revision` AS account_scope
  LEFT JOIN `community_channel` AS channel ON channel.`id` = NEW.`channel_id`
  WHERE account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, NEW.`last_read_at` FROM `community_channel`
  WHERE `id` = NEW.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'read-state-update:' || NEW.`id` || ':' || account_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', NEW.`channel_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE channel.`id` = NEW.`channel_id` AND channel.`server_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_read_state_delete` BEFORE DELETE ON `community_read_state` BEGIN
  INSERT INTO `community_replica_scope_revision` VALUES ('account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', OLD.`user_id`, account_scope.`revision`, 'read-state-delete:' || OLD.`id` || ':' || account_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'read-state-refresh', 'channelId', OLD.`channel_id`, 'serverId', channel.`server_id`)
  FROM `community_replica_scope_revision` AS account_scope
  LEFT JOIN `community_channel` AS channel ON channel.`id` = OLD.`channel_id`
  WHERE account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = OLD.`user_id`;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', `server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `community_channel`
  WHERE `id` = OLD.`channel_id` AND `server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'read-state-delete:' || OLD.`id` || ':' || account_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', OLD.`channel_id`)
  FROM `community_channel` AS channel
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = OLD.`user_id`
  WHERE channel.`id` = OLD.`channel_id` AND channel.`server_id` IS NOT NULL;
END;

CREATE TRIGGER `replica_mention_insert` AFTER INSERT ON `community_mention` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'mention:' || NEW.`id` || ':' || account_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', channel.`server_id`)
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', channel.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'mention:' || NEW.`id` || ':' || account_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', channel.`id`)
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_mention_update` AFTER UPDATE ON `community_mention` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'account', NEW.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', NEW.`user_id`, account_scope.`revision`, 'mention-update:' || NEW.`id` || ':' || account_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', channel.`server_id`)
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', channel.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'mention-update:' || NEW.`id` || ':' || account_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', channel.`id`)
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = NEW.`user_id`
  WHERE message.`id` = NEW.`message_id` AND channel.`server_id` IS NOT NULL;
END;
CREATE TRIGGER `replica_mention_delete` BEFORE DELETE ON `community_mention` BEGIN
  INSERT INTO `community_replica_scope_revision`
  SELECT 'account', OLD.`user_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  WHERE message.`id` = OLD.`message_id` AND channel.`server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'account', OLD.`user_id`, account_scope.`revision`, 'mention-delete:' || OLD.`id` || ':' || account_scope.`revision`, account_scope.`updated_at`, json_object('kind', 'server-refresh', 'serverId', channel.`server_id`)
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = OLD.`user_id`
  WHERE message.`id` = OLD.`message_id` AND channel.`server_id` IS NOT NULL;
  INSERT INTO `community_replica_scope_revision`
  SELECT 'server', channel.`server_id`, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  WHERE message.`id` = OLD.`message_id` AND channel.`server_id` IS NOT NULL
  ON CONFLICT (`scope_kind`, `scope_id`) DO UPDATE SET `revision` = `community_replica_scope_revision`.`revision` + 1, `updated_at` = excluded.`updated_at`;
  INSERT INTO `community_replica_delta` (`scope_kind`, `scope_id`, `revision`, `causal_id`, `committed_at`, `descriptor`)
  SELECT 'server', channel.`server_id`, server_scope.`revision`, 'mention-delete:' || OLD.`id` || ':' || account_scope.`revision`, server_scope.`updated_at`, json_object('kind', 'unread-source-refresh', 'channelId', channel.`id`)
  FROM `community_message` AS message
  JOIN `community_channel` AS channel ON channel.`id` = message.`channel_id`
  JOIN `community_replica_scope_revision` AS server_scope ON server_scope.`scope_kind` = 'server' AND server_scope.`scope_id` = channel.`server_id`
  JOIN `community_replica_scope_revision` AS account_scope ON account_scope.`scope_kind` = 'account' AND account_scope.`scope_id` = OLD.`user_id`
  WHERE message.`id` = OLD.`message_id` AND channel.`server_id` IS NOT NULL;
END;
