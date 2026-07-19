ALTER TABLE `users` ADD `daily_keyword_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `daily_keyword_limit` int DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_reset_date` varchar(10);