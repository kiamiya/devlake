CREATE TABLE `questions` (
	`project_id` text NOT NULL,
	`issue_number` integer NOT NULL,
	`question_id` text NOT NULL,
	`source` text NOT NULL,
	`issue_title` text NOT NULL,
	`blocking` integer NOT NULL,
	`text` text NOT NULL,
	`context` text,
	`options` text NOT NULL,
	`asked_at` text NOT NULL,
	`answer_text` text,
	`answer_decision` integer,
	`answered_at` text,
	`notified` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`project_id`, `issue_number`, `question_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
