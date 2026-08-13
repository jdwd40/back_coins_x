# Back CoinX - Cryptocurrency Trading Simulator Backend

## Database Setup

### Prerequisites
- PostgreSQL installed
- User `****` with password `****`

### Initial Database Creation
```bash
# Connect to PostgreSQL as superuser
psql -U postgres

# Create main and test databases
CREATE DATABASE coins_x;
CREATE DATABASE coins_x_test;

# Grant privileges to jd user
GRANT ALL PRIVILEGES ON DATABASE coins_x TO jd;
GRANT ALL PRIVILEGES ON DATABASE coins_x_test TO jd;
```

### Creating Tables
```bash
# For main database
psql -U jd -d coins_x -f db/migrations/001_create_tables.sql

# For test database
psql -U jd -d coins_x_test -f db/migrations/001_create_test_tables.sql
```

### Seeding Test Data
```bash
# Seed the main database with initial data
psql -U jd -d coins_x -f db/seeds/seed_data.sql
```

## Project Structure
```
back_coinsx/
├── src/              # Source code
├── db/               # Database related files
│   ├── migrations/   # Database migrations
│   └── seeds/        # Seed data
├── config/           # Configuration files
├── routes/           # API routes
├── middleware/       # Express middleware
├── controllers/      # Route controllers
└── models/           # Database models
```

## Database Schema

### Tables
- `Users`: Store user information and authentication details
- `Coins`: Information about cryptocurrencies
- `Transactions`: Log of buy/sell transactions
- `Portfolios`: Track user holdings
- `PriceHistory`: Historical price data for coins

See the migration files for detailed schema information.

---

## Environment Configuration

Create a `.env.development` file for development:
```
PGDATABASE=coins_x
JWT_SECRET=your-dev-secret   # used for both sign and verify (see shared config)
```

For production deployment on VPS, also set (JWT_SECRET is mandatory in prod):
```
JWT_SECRET=your-strong-random-prod-secret   # REQUIRED; same value used for sign+verify. No fallback.
PGDATABASE=coins_x   # or use DATABASE_URL for prod
FRONTEND_URL=https://yourdomain.com
# or http://your-vps-ip:port if using IP address

# PATCH /api/coins/:id/price is admin/system only (fail-closed):
ADMIN_USER_IDS=1                 # comma-separated user_ids allowed to mutate prices
# ADMIN_EMAILS=admin@example.com
# ADMIN_USERNAMES=admin_user
PRICE_ADMIN_API_KEY=long-random  # optional: X-System-Key / X-Admin-Key for internal tooling
```

In production (NODE_ENV=production) the server will fatal-exit before listening if JWT_SECRET missing/blank.

### Price-history retention migration (staging)

`db/migrations/007_extend_price_history_retention.sql` is portable (no `\c` switches). Apply against the **connected** app DB and the test DB:

```bash
# Confirm real DB name on the host first (README uses coins_x; some locals use coins)
psql -U jd -d coins_x -c '\conninfo'
psql -U jd -d coins_x -f db/migrations/007_extend_price_history_retention.sql
psql -U jd -d coins_x_test -f db/migrations/007_extend_price_history_retention.sql
```

## Installation

```bash
npm install
npm run setup-dbs
npm run seed
```

## CORS Configuration

The backend is configured to accept requests from:
- Local development environments (localhost:3000, 5173, 5174, 8080, etc.)
- Your production frontend (set via `FRONTEND_URL` environment variable)

This allows you to develop the frontend locally while connecting to the backend on your VPS.    