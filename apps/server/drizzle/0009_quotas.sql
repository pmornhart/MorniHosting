ALTER TABLE `servers` ADD `cpu_limit` real;--> statement-breakpoint
ALTER TABLE `servers` ADD `disk_limit_mb` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `quota` text;