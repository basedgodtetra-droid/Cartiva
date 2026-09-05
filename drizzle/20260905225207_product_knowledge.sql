CREATE TABLE `cartiva_category_semantics` (
	`category` text PRIMARY KEY NOT NULL,
	`rules` text NOT NULL,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cartiva_match_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`conceptId` text NOT NULL,
	`rejectedUpc` text NOT NULL,
	`acceptedUpc` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`stage` text NOT NULL,
	`confidence` real NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cartiva_correction_concept` ON `cartiva_match_corrections` (`conceptId`);--> statement-breakpoint
CREATE TABLE `cartiva_match_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`conceptId` text NOT NULL,
	`productId` text NOT NULL,
	`query` text NOT NULL,
	`outcome` text NOT NULL,
	`source` text NOT NULL,
	`checkedAt` integer NOT NULL,
	`store` text NOT NULL,
	`fulfillment` text NOT NULL,
	`price` real,
	`availability` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`packageSolution` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cartiva_observation_expiry` ON `cartiva_match_observations` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `cartiva_product_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`conceptId` text NOT NULL,
	`alias` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`stage` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastConfirmedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cartiva_alias_concept` ON `cartiva_product_aliases` (`conceptId`);--> statement-breakpoint
CREATE TABLE `cartiva_product_concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical` text NOT NULL,
	`category` text NOT NULL,
	`attributes` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`stage` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastConfirmedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cartiva_product_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`fromConcept` text NOT NULL,
	`toConcept` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`stage` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastConfirmedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cartiva_relationship_from` ON `cartiva_product_relationships` (`fromConcept`);--> statement-breakpoint
CREATE TABLE `cartiva_retailer_products` (
	`id` text PRIMARY KEY NOT NULL,
	`retailer` text NOT NULL,
	`upc` text NOT NULL,
	`conceptId` text NOT NULL,
	`title` text NOT NULL,
	`brand` text NOT NULL,
	`package` text NOT NULL,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`lastObservedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cartiva_product_concept` ON `cartiva_retailer_products` (`conceptId`);--> statement-breakpoint
CREATE TABLE `cartiva_search_query_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`conceptId` text NOT NULL,
	`retailer` text NOT NULL,
	`query` text NOT NULL,
	`successes` integer NOT NULL,
	`failures` integer NOT NULL,
	`quality` real NOT NULL,
	`stage` text NOT NULL,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastConfirmedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cartiva_query_concept` ON `cartiva_search_query_memory` (`conceptId`);