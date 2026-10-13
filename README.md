# Sample Full-Stack Demo App

A simple **Tasks** (to-do) app demonstrating a three-tier AWS architecture:

- **Frontend**: React + Vite, deployed to **AWS Amplify Hosting**
- **Backend**: Node.js + Express REST API, containerized with Docker, pushed to **Amazon ECR** and run on **AWS ECS (Fargate)**
- **Database**: **Amazon DynamoDB**

```
┌──────────────┐      HTTPS       ┌───────────────────┐      AWS SDK      ┌──────────────┐
│  React (Vite)│  ───────────────▶│  Express API      │  ───────────────▶ │  DynamoDB    │
│  AWS Amplify │   /api/tasks     │  ECS Fargate + ALB│   Tasks table     │  Tasks       │
└──────────────┘                  └───────────────────┘                   └──────────────┘
```

## Repository layout

```
sample app/
├── frontend/          # React + Vite app (deploy to Amplify)
│   ├── src/
│   ├── index.html
│   ├── package.json
│   └── .env.example
├── backend/           # Express API (containerized for ECS)
│   ├── src/
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
└── README.md
```

---

## 1. Backend — local run

```bash
cd backend
cp .env.example .env       # adjust values if needed
npm install
npm run dev                # starts on http://localhost:8080
```

Health check: `GET http://localhost:8080/health`
API: `GET/POST/DELETE http://localhost:8080/api/tasks`

### Local DynamoDB (optional)

For local testing without touching AWS, run DynamoDB Local:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
```

Then set in `backend/.env`:

```
DYNAMODB_ENDPOINT=http://localhost:8000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
```

Create the table locally:

```bash
aws dynamodb create-table \
  --table-name Tasks \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --endpoint-url http://localhost:8000 \
  --region us-east-1
```

---

## 2. Create the DynamoDB table (AWS)

```bash
aws dynamodb create-table \
  --table-name Tasks \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

---

## 3. Build & push the backend image to Amazon ECR

Set some variables (replace with your account ID and region):

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=123456789012
export ECR_REPO=sample-app-backend
```

Create the repository (one time):

```bash
aws ecr create-repository --repository-name $ECR_REPO --region $AWS_REGION
```

Authenticate Docker to ECR:

```bash
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
```

Build, tag, and push:

```bash
cd backend
docker build -t $ECR_REPO .
docker tag $ECR_REPO:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
```

The image URI you'll pull in ECS:

```
123456789012.dkr.ecr.us-east-1.amazonaws.com/sample-app-backend:latest
```

---

## 4. Run on ECS (Fargate) — you do this part

You mentioned you'll create the backend yourself by pulling the image from ECR. Here's what the ECS task needs:

**Container settings**
- Image: `<account>.dkr.ecr.<region>.amazonaws.com/sample-app-backend:latest`
- Container port: `8080`
- Health check path (on the ALB target group): `/health`

**Environment variables for the container**
| Variable         | Example       | Notes                                   |
| ---------------- | ------------- | --------------------------------------- |
| `PORT`           | `8080`        | Port the server listens on             |
| `AWS_REGION`     | `us-east-1`   | Region of the DynamoDB table           |
| `TASKS_TABLE`    | `Tasks`       | DynamoDB table name                    |
| `CORS_ORIGIN`    | `*`           | Set to your Amplify URL in production  |

**IAM task role** — attach a policy allowing DynamoDB access to the `Tasks` table:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:UpdateItem",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:123456789012:table/Tasks"
    }
  ]
}
```

Put the service behind an Application Load Balancer so Amplify can reach it over HTTPS. Note the ALB DNS name / custom domain — that's your API base URL.

---

## 5. Deploy the frontend to AWS Amplify

1. Push this repo to GitHub/GitLab/CodeCommit.
2. In the Amplify console: **New app → Host web app**, connect the repo.
3. Set the **app root / monorepo** build settings to the `frontend` directory.
4. Add an environment variable in Amplify:
   - `VITE_API_BASE_URL` = your ALB URL, e.g. `https://your-alb-123.us-east-1.elb.amazonaws.com`
5. Amplify auto-detects Vite. The build spec (`frontend/amplify.yml`) is included.

---

## Notes

- Keep `CORS_ORIGIN` restricted to your Amplify domain in a real deployment.
- The backend falls back to an in-memory store if it can't reach DynamoDB, so the demo still runs even before AWS is wired up (useful for local dev).
