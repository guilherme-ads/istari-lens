-- Analytics Database Seed
-- Read-only database with example views for testing

CREATE TABLE IF NOT EXISTS public.growth_users (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    category VARCHAR(50),
    channel VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    revenue DECIMAL(10, 2) DEFAULT 0.0
);

CREATE VIEW public.vw_growth_users AS
SELECT 
    id,
    created_at,
    category,
    channel,
    is_active,
    revenue
FROM public.growth_users;

-- Insert sample data
INSERT INTO public.growth_users (category, channel, is_active, revenue) VALUES
('enterprise', 'direct', true, 5000.00),
('enterprise', 'direct', true, 7500.00),
('enterprise', 'partner', true, 3200.00),
('mid-market', 'direct', true, 1500.00),
('mid-market', 'partner', false, 800.00),
('startup', 'organic', true, 200.00),
('startup', 'organic', true, 350.00),
('enterprise', 'inbound', true, 6000.00),
('mid-market', 'inbound', true, 1200.00),
('startup', 'direct', false, 100.00),
('enterprise', 'partner', true, 4500.00),
('mid-market', 'organic', true, 950.00),
('startup', 'partner', true, 150.00),
('enterprise', 'direct', true, 5500.00),
('mid-market', 'direct', true, 1800.00),
('startup', 'organic', true, 400.00),
('enterprise', 'inbound', true, 7000.00),
('mid-market', 'partner', true, 1100.00),
('startup', 'direct', true, 75.00),
('enterprise', 'organic', false, 6500.00);

-- Ensure view is readable without explicit grants (public schema)
GRANT SELECT ON public.vw_growth_users TO postgres;
GRANT SELECT ON public.growth_users TO postgres;
