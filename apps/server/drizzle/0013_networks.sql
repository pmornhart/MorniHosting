CREATE TABLE `network_members` (
	`server_id` text PRIMARY KEY NOT NULL,
	`network_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`network_id`) REFERENCES `networks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `networks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`proxy_server_id` text NOT NULL,
	`secret` text NOT NULL,
	`default_member` text,
	`online_mode` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `networks_proxy_server_id_unique` ON `networks` (`proxy_server_id`);