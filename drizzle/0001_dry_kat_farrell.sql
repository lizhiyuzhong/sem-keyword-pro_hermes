CREATE TABLE `analysis_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cacheKey` varchar(64) NOT NULL,
	`businessDirection` text NOT NULL,
	`businessType` varchar(8) NOT NULL,
	`keywords` text NOT NULL,
	`reportJson` text NOT NULL,
	`analyzedAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analysis_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `analysis_cache_cacheKey_unique` UNIQUE(`cacheKey`)
);
