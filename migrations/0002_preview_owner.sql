-- The throwaway owner the builder uses for owner previews of an app's draft ({ email, password }).
ALTER TABLE apps ADD COLUMN preview_owner TEXT;
