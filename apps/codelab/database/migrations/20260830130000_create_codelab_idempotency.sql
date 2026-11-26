create table codelab.idempotency_keys (
    idempotency_key text primary key,
    operation text not null,
    response jsonb not null,
    created_at timestamptz not null default now(),
    constraint idempotency_keys_key_not_blank_check check (btrim(idempotency_key) <> ''),
    constraint idempotency_keys_operation_not_blank_check check (btrim(operation) <> '')
);
