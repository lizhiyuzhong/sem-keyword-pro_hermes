CREATE TABLE `client_keyword_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`clientId` int NOT NULL,
	`keyword` varchar(500) NOT NULL,
	`analysisResultJson` mediumtext NOT NULL,
	`analyzedAt` bigint NOT NULL,
	CONSTRAINT `client_keyword_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`businessDirection` text NOT NULL,
	`businessType` enum('B2B','B2C') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `clients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_ckh_clientId` ON `client_keyword_history` (`clientId`);--> statement-breakpoint
CREATE INDEX `idx_clients_userId` ON `clients` (`userId`);