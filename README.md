# Metro E-Commerce Backend

Backend API for Assignment 5, built with Node.js, Express, Prisma, and PostgreSQL.

## Live URL
- Backend: `https://your-backend-url.vercel.app`
- API Docs: `https://your-backend-url.vercel.app/api-docs`

## Features
- Authentication
  - Register/Login
  - JWT access + refresh token flow
  - Password reset flow
  - Google OAuth (Passport)
- Role-based authorization (Admin/User) via middleware
- Core e-commerce modules:
  - Users & addresses
  - Categories
  - Products
  - Cart
  - Orders
  - Reviews
  - Media uploads
- Payment integration:
  - Stripe
  - SSLCommerz
- Validation and API schema:
  - Zod request validation
  - OpenAPI/Swagger docs
- Global error handling and consistent API responses

## Tech Stack
- Node.js
- Express 5
- Prisma ORM
- PostgreSQL
- Zod
- Passport
- JWT

## API Base
- Local: `http://localhost:5000/api`
- Docs: `http://localhost:5000/api-docs`

## Environment Variables
Create `.env` (or copy from `.env.example`) and configure all required values:

```env
PORT=5000
NODE_ENV=development
DATABASE_URL=postgresql://...
FRONTEND_URL=http://localhost:3000

EXPRESS_SESSION_SECRET=...
BCRYPT_SALT_ROUND=12

JWT_ACCESS_SECRET=...
JWT_ACCESS_EXPIRES=1d
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRES=30d
JWT_RESET_PASSWORD_EXPIRES=15m

SUPER_ADMIN_EMAIL=admin@example.com
SUPER_ADMIN_PASSWORD=strong-password

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:5000/api/auth/google/callback

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=...

CLOUDINARY_URL=...
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

STRIPE_SECRET_KEY=...
STRIPE_SUCCESS_URL=http://localhost:3000/cart
STRIPE_CANCEL_URL=http://localhost:3000/cart
STRIPE_CURRENCY=bdt

SSL_STORE_ID=...
SSL_STORE_PASS=...
SSL_PAYMENT_API=https://sandbox.sslcommerz.com/gwprocess/v4/api.php
SSL_VALIDATION_API=https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php
SSL_SUCCESS_BACKEND_URL=http://localhost:5000/api/payment/ssl/success
SSL_FAIL_BACKEND_URL=http://localhost:5000/api/payment/ssl/fail
SSL_CANCEL_BACKEND_URL=http://localhost:5000/api/payment/ssl/cancel
SSL_IPN_URL=http://localhost:5000/api/payment/ssl/ipn
```

## Run Locally
```bash
npm install
npm run dev
```

## Build & Start
```bash
npm run build
npm start
```

## Seed Admin
```bash
npm run seed:admin
```

## Assignment Submission Info (Fill Before Submission)
- Backend Repo: `https://github.com/your-username/project-backend`
- Backend Live URL: `https://your-backend-url.vercel.app`
- Demo Video: `https://drive.google.com/...`
- Admin Email: `admin@project.com`
- Admin Password: `your-admin-password`

## Important
- Never commit real secrets from `.env`.
- Rotate leaked credentials before submission.
