CREATE TABLE `community_read_state_revision` (
  `user_id` text PRIMARY KEY NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
