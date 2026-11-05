CREATE TABLE `issues` (
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`state` text NOT NULL,
	`labels` text NOT NULL,
	`author` text NOT NULL,
	PRIMARY KEY(`project_id`, `number`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`added_at` text NOT NULL,
	`last_synced_at` text
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`project_id` text NOT NULL,
	`id` integer NOT NULL,
	`name` text NOT NULL,
	`workflow` text NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`head_branch` text NOT NULL,
	`event` text NOT NULL,
	`created_at` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tabs` (
	`project_id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
