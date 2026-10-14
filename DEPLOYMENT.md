# Deployment Guide — Tasks Demo App

This guide walks you through deploying the full three-tier app on AWS:

- **Frontend**: React + Vite on **AWS Amplify Hosting** (source from GitHub)
- **Backend**: Express API in a Docker container on **AWS ECS (Fargate)**, image stored in **Amazon ECR**
- **Database**: **Amazon DynamoDB**

> **Recommended order:** Database → Backend (ECS) → Frontend (Amplify).
> The backend needs the DynamoDB table to exist, and the frontend needs the
> backend's load balancer URL. The sections below are numbered in the order you
> asked, but a "Do this in order" note at the top of each section tells you what
> must already exist.

**Prerequisites**

- An AWS account and the **AWS CLI** configured (`aws configure`) on whatever machine runs CLI commands.
- A machine with **Docker** for the image build. Your laptop has no admin rights, so use an **EC2 instance** (covered in Part 2).
- Code already on GitHub: **https://github.com/jerryd1983/sample-app**

Set these shell variables once (replace with your real values). Examples use `us-east-1`:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=123456789012     # your 12-digit account ID
export ECR_REPO=sample-app-backend
export TASKS_TABLE=Tasks
```

---

## Part 1 — GitHub and AWS Amplify (frontend)

> **Do this in order:** The code is already on GitHub (done). Do the Amplify
> connection **last**, after Part 2, because you need the backend's load
> balancer URL to set `VITE_API_BASE_URL`. You can still connect the repo now
> and just add/update that variable once the ALB exists — a redeploy picks it up.

### 1.1 Confirm the code is on GitHub

Already pushed to:

```
https://github.com/jerryd1983/sample-app   (branch: main)
```

If you make changes later:

```bash
git add .
git commit -m "your message"
git push
```

Amplify auto-rebuilds on every push to the connected branch.

### 1.2 Create the Amplify app

1. Open the **AWS Amplify** console → **Create new app** → **Host web app**.
2. Choose **GitHub** as the source and authorize AWS Amplify to access your repos.
3. Select the **`jerryd1983/sample-app`** repository and the **`main`** branch.
4. **Monorepo setting:** this repo has both `frontend/` and `backend/`, so tell
   Amplify the app lives in a subfolder. Set the **app root directory** to:
   ```
   frontend
   ```
5. Amplify detects Vite and reads the build spec at `frontend/amplify.yml`
   (already in the repo). It builds with `npm ci && npm run build` and publishes
   the `dist` folder. Leave the auto-detected settings as-is.

### 1.3 Set the backend URL environment variable

The frontend reads `VITE_API_BASE_URL` at build time to know where the API is.

1. In the Amplify app → **Hosting** → **Environment variables**.
2. Add:
   | Key                 | Value                                             |
   | ------------------- | ------------------------------------------------- |
   | `VITE_API_BASE_URL` | `https://<your-alb-dns-name>`  (from Part 2.8)    |
3. **Redeploy** so the new value is baked into the build.

> If you haven't finished Part 2 yet, leave this unset for now and come back.
> Without it, the deployed site will try to call `/api/...` on the Amplify
> origin and fail — that's expected until the backend URL is set.

### 1.4 Deploy

Click **Save and deploy**. When the build finishes you'll get a URL like:

```
https://main.d1a2b3c4d5.amplifyapp.com
```

Keep this URL — you'll use it as the backend's `CORS_ORIGIN` in Part 2.

---

## Part 2 — AWS ECS: push to ECR, then build/run the backend

> **Do this in order:** Create the DynamoDB table first (Part 3) so the task's
> IAM role and env vars line up. The build must run on a Docker-capable machine;
> these steps assume an EC2 instance because your laptop can't install Docker.

### 2.1 Launch an EC2 instance for building

1. EC2 console → **Launch instance**.
2. AMI: **Amazon Linux 2023**. Type: `t3.small` is plenty.
3. **Attach an IAM role** to the instance with ECR push permissions. Easiest for
   a demo: a role with the managed policy **`AmazonEC2ContainerRegistryPowerUser`**.
   (Using an instance role avoids putting access keys on the box.)
4. Launch, then connect via **EC2 Instance Connect** or SSH.

### 2.2 Install Docker and tools on the instance

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker          # apply the group change without logging out
```

The AWS CLI is preinstalled on Amazon Linux 2023. Verify:

```bash
docker --version
aws --version
```

### 2.3 Get the code onto the instance

```bash
git clone https://github.com/jerryd1983/sample-app.git
cd sample-app/backend
```

> The repo is private. Either make it public temporarily, use a GitHub
> personal access token when prompted, or install the GitHub CLI (`gh`) and run
> `gh auth login`. Only the `backend/` folder is needed for the build.

### 2.4 Create the ECR repository (one time)

```bash
aws ecr create-repository \
  --repository-name "$ECR_REPO" \
  --region "$AWS_REGION"
```

### 2.5 Authenticate Docker to ECR

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
```

### 2.6 Build, tag, and push the image

```bash
# from sample-app/backend
docker build -t "$ECR_REPO" .

docker tag "$ECR_REPO:latest" \
  "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest"

docker push \
  "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest"
```

Your image URI (used in the ECS task definition):

```
<account>.dkr.ecr.<region>.amazonaws.com/sample-app-backend:latest
```

### 2.7 Create the ECS cluster and task definition

1. ECS console → **Clusters** → **Create cluster**. Choose **AWS Fargate**
   (serverless). Name it e.g. `sample-app-cluster`.
2. **Task definitions** → **Create new task definition**:
   - Launch type: **Fargate**
   - CPU/memory: `0.25 vCPU` / `0.5 GB` is enough for the demo
   - **Container**:
     - Name: `backend`
     - Image URI: the one from 2.6
     - Port mapping: **container port `8080`**, protocol TCP
   - **Environment variables** on the container:
     | Variable      | Value                               |
     | ------------- | ----------------------------------- |
     | `PORT`        | `8080`                              |
     | `AWS_REGION`  | `us-east-1`                         |
     | `TASKS_TABLE` | `Tasks`                             |
     | `CORS_ORIGIN` | your Amplify URL (from Part 1.4)    |
   - **Task role**: a role the container assumes to call DynamoDB. Attach the
     policy from Part 3.3. (This is the *task role*, separate from the *task
     execution role* below.)
   - **Task execution role**: `ecsTaskExecutionRole` (lets ECS pull from ECR and
     write logs). The console offers to create it if you don't have one.
   - Enable **CloudWatch logs** so you can see container output.

### 2.8 Create the service behind an internet-facing ALB

1. In the cluster → **Create service**.
   - Launch type: **Fargate**, Task definition: the one from 2.7, Desired tasks: `1`.
2. **Networking:**
   - Pick your VPC. Place **tasks in private subnets** (no public IP) for a clean
     setup, or public subnets with "assign public IP" on if you want to skip NAT
     for the demo.
   - The tasks need to reach DynamoDB. Either add a **DynamoDB gateway VPC
     endpoint** (free, recommended) or ensure a NAT gateway exists.
3. **Load balancer:**
   - Create an **Application Load Balancer**, **scheme = internet-facing**, in
     **public subnets**. (It must be public — the browser calls it directly from
     the internet. A private/internal ALB would be unreachable from the Amplify
     frontend.)
   - Listener: `80` (or `443` with an ACM certificate for HTTPS).
   - Target group: protocol HTTP, **port `8080`**, target type **IP**.
   - **Health check path: `/health`** (the app exposes this).
4. **Security groups:**
   - **ALB SG:** inbound `80`/`443` from `0.0.0.0/0`.
   - **Task SG:** inbound `8080` **only from the ALB security group** (not the
     internet).
5. Create the service. When it's healthy, note the **ALB DNS name**:
   ```
   http://sample-app-alb-123456.us-east-1.elb.amazonaws.com
   ```
   This is your `VITE_API_BASE_URL` for Part 1.3.

### 2.9 Verify the backend

```bash
curl http://<alb-dns-name>/health
# -> {"status":"ok","storage":"dynamodb"}
```

If `storage` says `in-memory`, the container couldn't reach DynamoDB — check the
task role permissions (Part 3.3) and the `AWS_REGION`/`TASKS_TABLE` env vars.

---

## Part 3 — Create the database (DynamoDB)

> **Do this first**, before the backend service runs, so the table exists when
> the container starts.

### 3.1 Create the table

The app uses a single table with a string partition key `id`:

```bash
aws dynamodb create-table \
  --table-name "$TASKS_TABLE" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$AWS_REGION"
```

`PAY_PER_REQUEST` (on-demand) means no capacity planning and near-zero cost for a demo.

### 3.2 Confirm it's active

```bash
aws dynamodb describe-table \
  --table-name "$TASKS_TABLE" \
  --region "$AWS_REGION" \
  --query "Table.TableStatus"
# -> "ACTIVE"
```

### 3.3 IAM policy for the ECS task role

Attach this policy to the **ECS task role** from Part 2.7 so the container can
read/write the table. Replace the account ID/region/table in the ARN:

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

### 3.4 (Optional) Seed or inspect data

List items:

```bash
aws dynamodb scan --table-name "$TASKS_TABLE" --region "$AWS_REGION"
```

Add a test item directly:

```bash
aws dynamodb put-item \
  --table-name "$TASKS_TABLE" \
  --item '{"id":{"S":"demo-1"},"title":{"S":"Hello from DynamoDB"},"completed":{"BOOL":false},"createdAt":{"N":"1700000000000"}}' \
  --region "$AWS_REGION"
```

---

## End-to-end checklist

1. [ ] **Part 3** — DynamoDB `Tasks` table created and `ACTIVE`; task-role policy ready.
2. [ ] **Part 2** — EC2 built the image and pushed to ECR.
3. [ ] **Part 2** — ECS service running behind an internet-facing ALB; `/health` returns `"storage":"dynamodb"`.
4. [ ] **Part 1** — Amplify connected to GitHub, `VITE_API_BASE_URL` = ALB URL, redeployed.
5. [ ] **Part 2** — Backend `CORS_ORIGIN` = Amplify URL (update the task definition and redeploy the service if you set it after Part 1).
6. [ ] Open the Amplify URL, add a task, confirm it appears (and shows up in `dynamodb scan`).

## Troubleshooting

- **Frontend loads but tasks fail to load** → `VITE_API_BASE_URL` wrong/missing, or CORS. Check the browser console; set `CORS_ORIGIN` on the backend to the exact Amplify origin.
- **`/health` shows `in-memory`** → container can't reach DynamoDB. Check task role policy, region, table name, and that the tasks have a network path to DynamoDB (VPC endpoint or NAT).
- **ECS task won't start / can't pull image** → task *execution* role missing ECR permissions, or wrong image URI.
- **ALB targets unhealthy** → health check path must be `/health`, target group port must be `8080`, and the task SG must allow `8080` from the ALB SG.
- **502 from ALB** → container not listening on `8080` or still starting; check CloudWatch logs.
