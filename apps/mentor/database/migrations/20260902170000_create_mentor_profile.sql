create table mentor.mentor_profile (
    topic text primary key check (btrim(topic) <> ''),
    hypothesis text not null check (btrim(hypothesis) <> ''),
    confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
    user_correction text,
    updated_at timestamptz not null default now()
);
