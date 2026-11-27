-- M10.6: quote list views each staff member saved ([{ name, query }]).
ALTER TABLE "StaffMember" ADD COLUMN "savedViews" JSONB NOT NULL DEFAULT '[]';
