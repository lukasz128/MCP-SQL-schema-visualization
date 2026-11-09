-- Small shop schema, PostgreSQL flavour.
-- Exercises: inline and table-level keys, defaults, a self-reference,
-- a composite FK, ALTER TABLE ... ADD CONSTRAINT, a view, and statements
-- the visualizer must skip without failing.

CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');

CREATE TABLE public.customers (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    full_name   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id         INTEGER PRIMARY KEY,
    parent_id  INTEGER REFERENCES categories (id),
    name       TEXT NOT NULL
);

CREATE TABLE products (
    id           INTEGER,
    category_id  INTEGER NOT NULL,
    sku          VARCHAR(32) NOT NULL,
    price        NUMERIC(10,2) NOT NULL DEFAULT 0,
    tags         TEXT[],
    CONSTRAINT products_pkey PRIMARY KEY (id),
    CONSTRAINT products_sku_key UNIQUE (sku),
    CONSTRAINT products_category_fk FOREIGN KEY (category_id) REFERENCES categories (id)
);

CREATE TABLE orders (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  INTEGER NOT NULL,
    status       VARCHAR(16) NOT NULL DEFAULT 'new',
    note         TEXT
);

CREATE TABLE order_items (
    order_id    BIGINT NOT NULL REFERENCES orders (id),
    line_no     INTEGER NOT NULL,
    product_id  INTEGER NOT NULL REFERENCES products (id),
    quantity    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, line_no)
);

CREATE TABLE shipments (
    id        SERIAL PRIMARY KEY,
    order_id  BIGINT NOT NULL,
    line_no   INTEGER NOT NULL,
    shipped   BOOLEAN DEFAULT false,
    FOREIGN KEY (order_id, line_no) REFERENCES order_items (order_id, line_no)
);

ALTER TABLE orders
    ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES public.customers (id);

CREATE INDEX orders_customer_idx ON orders (customer_id);

COMMENT ON TABLE orders IS 'One row per checkout; see order_items.';

CREATE FUNCTION touch() RETURNS trigger AS $$
BEGIN
  NEW.created_at := now(); -- semicolons inside the body must not split
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- node-sql-parser 5.4 cannot parse identity columns yet: this one becomes a warning.
CREATE TABLE audit_log (
    id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message TEXT
);

INSERT INTO categories (id, name) VALUES (1, 'Books; and more');

CREATE VIEW order_totals AS
SELECT o.id AS order_id, c.email, sum(i.quantity * p.price) AS total
FROM orders o
JOIN public.customers c ON c.id = o.customer_id
JOIN order_items i ON i.order_id = o.id
JOIN products p ON p.id = i.product_id
GROUP BY o.id, c.email;
