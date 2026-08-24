CREATE TABLE `community_forum_opener_read` (
  `user_id` text NOT NULL,
  `opener_message_id` text NOT NULL,
  `read_at` text NOT NULL,
  PRIMARY KEY (`user_id`, `opener_message_id`),
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`opener_message_id`) REFERENCES `community_message`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `idx_forum_opener_read_message`
  ON `community_forum_opener_read` (`opener_message_id`);
