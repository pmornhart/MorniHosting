CREATE TABLE `charge_payments` (
	`charge_id` integer NOT NULL,
	`month` text NOT NULL,
	`paid_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`marked_by` text NOT NULL,
	PRIMARY KEY(`charge_id`, `month`),
	FOREIGN KEY (`charge_id`) REFERENCES `charges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `charges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`server_name` text NOT NULL,
	`user_id` integer,
	`user_name` text NOT NULL,
	`code` text NOT NULL,
	`monthly_cents` integer NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ended_at` text
);
