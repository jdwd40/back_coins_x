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

create .env.development
PGDATABASE=coins_x


npm install
npm run setup-dbs
npm run seed    