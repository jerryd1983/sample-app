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
3. On **Add repository and branch**, select the **`jerryd1983/sample-app`**
   repository and the **`main`** branch.
4. **Tick the "My app is a monorepo" checkbox.** This repo has both `frontend/`
   and `backend/` at the root, and the React app lives in the `frontend`
   subfolder — not at the repo root — so Amplify needs to know where the app is.
   In the **Monorepo root directory** field that appears, enter exactly:
   ```
   frontend
   ```
   (no leading slash — just the folder name).

   > If you leave this unchecked, Amplify looks at the repo root, finds no
   > `package.json` there, and the build fails.
5. Continue to **App settings**. Amplify reads the monorepo build spec at the
   **repo root** `amplify.yml` (already in the repo). It uses the `applications:`
   format with `appRoot: frontend`, builds with `npm install && npm run build`,
   and publishes `frontend/dist`. Leave the auto-detected settings as-is.

   > **Why the spec is at the repo root (not in `frontend/`):** when the
   > monorepo checkbox is ticked, Amplify requires a build spec with an
   > `applications:` key and reads it from the repository root. A single-app
   > spec (top-level `frontend:` with no `applications:`) produces the build
   > error `Monorepo spec provided without "applications" key`. The included
   > root `amplify.yml` already uses the correct monorepo format.

### 1.3 Set the backend URL environment variable

The frontend reads `VITE_API_BASE_URL` at build time to know where the API is.

1. In the Amplify app → **Hosting** → **Environment variables**.
2. Add:
   | Key                 | Value                                             |
   | ------------------- | ------------------------------------------------- |
   | `VITE_API_BASE_URL` | `https://<your-alb-dns-name>`  (from Part 2.9)    |
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

Confirm the Docker **daemon** is actually running (installing Docker doesn't
always start it):

```bash
sudo systemctl status docker      # should say "active (running)"
```

If it's not running, start it (and enable it so it survives reboots):

```bash
sudo systemctl enable --now docker
```

> **If a later `docker` command fails with**
> `Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?`
> the daemon isn't started — run `sudo systemctl start docker`. If instead you
> get a **permission denied** on the socket, your user isn't in the `docker`
> group yet: run `sudo usermod -aG docker $USER` then `newgrp docker` (or prefix
> the command with `sudo` as a quick test).

### 2.3 Get the code onto the instance

```bash
git clone https://github.com/jerryd1983/sample-app.git
cd sample-app/backend
```

> The repo is private. Either make it public temporarily, use a GitHub
> personal access token when prompted, or install the GitHub CLI (`gh`) and run
> `gh auth login`. Only the `backend/` folder is needed for the build.

### 2.4 Create the ECR repository (one time) — console (GUI)

Create the repository in the AWS console instead of the CLI:

1. Open the **Amazon ECR** console.
2. In the top-right **region selector**, choose your region (e.g.
   **US East (N. Virginia) us-east-1**). This is the region the repo lives in —
   make sure it matches the region you use everywhere else.
3. Left nav → **Repositories** → make sure the **Private** tab is selected
   (not **Public**).
4. Click **Create repository**.
5. **Visibility settings:** leave it on **Private**. (Private is correct here —
   your ECS task pulls the image using its IAM role, so it never needs to be
   public.)
6. **Repository name:** `sample-app-backend`.
7. Leave the rest at defaults (tag mutability, scan-on-push, encryption are all
   fine as-is for a demo).
8. Click **Create repository**.

After it's created, open the repository and note its **URI** at the top — it
looks like:

```
<account>.dkr.ecr.<region>.amazonaws.com/sample-app-backend
```

That's the value you'll use in 2.6 and in the ECS task definition.

### 2.5 Authenticate Docker to ECR

Your ECR repository is private, so ECR rejects anonymous pushes and pulls. The
`get-login-password` command asks AWS (using the instance's IAM role) for a
short-lived authentication token, and `docker login` hands that token to Docker.
This proves to ECR that you're allowed to push, and it links Docker to *your*
account's registry endpoint so `docker push` knows where the image should go.
The token expires after 12 hours, so re-run this command if a later push is
rejected with an auth error.

> **First set the region** on the EC2 box so you don't hit "invalid endpoint".
> Either export the variables or just hardcode the region in the commands:
> ```bash
> export AWS_REGION=us-east-1
> export AWS_ACCOUNT_ID=123456789012     # your 12-digit account ID
> export ECR_REPO=sample-app-backend
> # verify:
> echo "region='$AWS_REGION' account='$AWS_ACCOUNT_ID'"
> aws configure list        # 'region' should not be empty
> ```

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
```

> **Run login and push as the same user.** `docker login` saves the ECR token to
> the home directory of whoever runs it. `ec2-user` and `root` (via `sudo`) have
> **separate** Docker configs, so if you log in as one and push as the other,
> you'll get `no basic auth credentials`. The simplest fix is to drop `sudo`
> entirely (add your user to the `docker` group — see step 2.2 — then run `docker`
> plain). But **if you do use `sudo` for Docker, use it for every Docker command,
> including `docker login`** — i.e. `sudo docker login ...` *and* `sudo docker
> push ...`. Don't mix `docker login` with `sudo docker push`.

**What each line does:**

- `export AWS_REGION=us-east-1` — stores your AWS region in a shell variable so
  the later commands can reuse it with `$AWS_REGION` instead of repeating it.
- `export AWS_ACCOUNT_ID=123456789012` — stores your 12-digit AWS account ID;
  it's part of the ECR registry address. Replace it with your real account ID.
- `export ECR_REPO=sample-app-backend` — stores the repository name you created
  in 2.4.
- `echo "region='$AWS_REGION' account='$AWS_ACCOUNT_ID'"` — prints the variables
  back so you can confirm they're set and spelled correctly (a common cause of
  the "invalid endpoint" error is an empty region).
- `aws configure list` — shows the CLI's effective settings; check that `region`
  is not blank. If it is, run `aws configure set region us-east-1`.
- `aws ecr get-login-password ...` — asks AWS for a temporary ECR login token.
- `| docker login --username AWS --password-stdin ...` — pipes that token
  straight into `docker login`, authenticating Docker to your account's private
  ECR registry (`<account>.dkr.ecr.<region>.amazonaws.com`) so the next step can
  push to it.

### 2.6 Build, tag, and push the image

```bash
# from sample-app/backend
docker build -t "$ECR_REPO" .

docker tag "$ECR_REPO:latest" \
  "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest"

docker push \
  "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest"
```

**What each line does:**

- `docker build -t "$ECR_REPO" .` — reads the `Dockerfile` in the current folder
  (the `.`) and builds the image, copying in your source and running
  `npm install`. The `-t` tags it with a local name (`sample-app-backend`).
- `docker tag "$ECR_REPO:latest" "<account>.dkr.ecr.<region>.amazonaws.com/..."`
  — adds a second name to that same image: its full ECR address. Docker uses
  this address to know which registry and repository to push to. (It doesn't
  copy the image, just labels it.)
- `docker push "<account>.dkr.ecr.<region>.amazonaws.com/...:latest"` — uploads
  the tagged image to your private ECR repository. This is the step that
  actually gets the image into AWS so ECS can pull it.

> **Why tag the image?** `docker push` figures out *where* to upload entirely
> from the image's name — there's no separate destination argument. The full
> name encodes the registry (your account + region), the repository, and the
> version tag:
> ```
> 123456789012.dkr.ecr.us-east-1.amazonaws.com / sample-app-backend : latest
> └──────────────── registry ────────────────┘   └── repository ──┘  └ tag ┘
> ```
> The build-time name (`sample-app-backend:latest`) has no registry prefix, so
> Docker would assume Docker Hub. `docker tag` adds a second label with the full
> ECR address — it doesn't copy the image, just points another name at the same
> image — so `docker push` knows to send it to your ECR. The tag part (`:latest`)
> is the version label; ECR can hold many versions of a repo, and your ECS task
> definition pulls one by tag.

Your image URI (used in the ECS task definition):

```
<account>.dkr.ecr.<region>.amazonaws.com/sample-app-backend:latest
```

### 2.7 Create the two IAM roles the task needs

A Fargate task uses **two different IAM roles**, and mixing them up is a common
source of errors. They operate at different stages:

| | **Task execution role** | **Task role** |
| --- | --- | --- |
| **Who uses it** | The ECS/Fargate **agent** (the platform), *before* your app starts | Your **application code** inside the container, *while* it runs |
| **What it's for** | Pulling the image from ECR and sending logs to CloudWatch | Calling AWS services your app talks to — here, DynamoDB |
| **Analogy** | The delivery crew that sets up the container | The employee working inside the container |
| **This app needs** | `AmazonECSTaskExecutionRolePolicy` | DynamoDB access (policy in Part 3.3) |

In short: the **execution role** gets your container *running* (pull image, write
logs); the **task role** lets the running code *do its job* (read/write
DynamoDB). If the execution role is wrong, the task won't even start. If the task
role is wrong, the task starts but DynamoDB calls fail (and the app falls back to
`in-memory`).

#### Create the task execution role

Most accounts already have `ecsTaskExecutionRole`. The ECS console offers to
create it automatically when you build the task definition — accept that if
prompted. To create it manually:

1. IAM console → **Roles** → **Create role**.
2. Trusted entity: **AWS service** → use case **Elastic Container Service** →
   **Elastic Container Service Task**.
3. Attach the AWS managed policy **`AmazonECSTaskExecutionRolePolicy`** (grants
   ECR pull + CloudWatch logs).
4. Name it `ecsTaskExecutionRole` → **Create role**.

#### Create the task role

1. IAM console → **Roles** → **Create role**.
2. Trusted entity: **AWS service** → use case **Elastic Container Service** →
   **Elastic Container Service Task** (same trust as above).
3. **Create role first** with no policy, name it `sample-app-task-role`, then
   open it and add an **inline policy** using the DynamoDB JSON in **Part 3.3**
   (it scopes access to just the `Tasks` table). Click through, name the policy
   `TasksTableAccess`, and save.
4. You'll select this role as the **Task role** in the task definition below.

> You attach **both** roles in the task definition: `ecsTaskExecutionRole` as the
> *task execution role*, and `sample-app-task-role` as the *task role*.

### Key ECS concepts (quick reference)

Before creating these, here's what the pieces are:

- **Cluster** — a logical grouping that your tasks and services run in. With
  Fargate it's just a namespace; you don't manage any servers.
- **Task definition** — the **blueprint** for your container(s): which image to
  run, how much CPU/memory, port mappings, environment variables, and the IAM
  roles. It's a template and doesn't run anything on its own. Each edit creates a
  new **revision**.
- **Task** — one **running instance** of a task definition (your container
  actually running). You can run a task once and let it stop, but for a web API
  you want it always on — that's what a service is for.
- **Service** — the **manager** that keeps a desired number of tasks running from
  a task definition. It launches them, replaces any that crash or fail health
  checks, registers them with the load balancer, and handles rolling updates when
  you deploy a new revision.

> **Analogy:** the task definition is a *recipe*, a task is one *cooked dish*,
> and the service is the *kitchen manager* making sure there's always the desired
> number of fresh dishes on the counter.

### 2.8 Create the ECS cluster and task definition

#### Create the cluster

1. Open the Amazon ECS console at **console.aws.amazon.com/ecs/v2**.
2. **Clusters** → **Create cluster**.
3. **Cluster name:** `sample-app-cluster`.
4. Under **Infrastructure**, make sure **AWS Fargate (serverless)** is checked
   (it's the default). Leave everything else at defaults.
5. **Create**.

#### Create the task definition (new console flow)

ECS now walks you through the task definition in named sections. **Task
definitions** → **Create new task definition** (the console form, not JSON):

1. **Task definition configuration**
   - **Task definition family:** `sample-app-backend`

2. **Infrastructure requirements**
   - **Launch type:** **AWS Fargate**
   - **Operating system/Architecture:** **Linux/X86_64**
   - **Task size:** **CPU** = `.25 vCPU`, **Memory** = `.5 GB`
   - **Task role:** select `sample-app-task-role` (created in 2.7) — lets the
     running container read/write DynamoDB.
   - **Task execution role:** select `ecsTaskExecutionRole` (created in 2.7) —
     lets ECS pull the image from ECR and write logs. (If the dropdown offers
     "Create new role", you can let it create the default execution role here.)

3. **Container - 1** (the "Container" section)
   - **Name:** `backend`
   - **Image URI:** paste the full URI from 2.6, e.g.
     `944642316987.dkr.ecr.us-east-1.amazonaws.com/sample-app-backend:latest`
   - **Essential container:** **Yes**
   - **Port mappings:** **Container port** = `8080`, **Protocol** = `TCP`,
     **App protocol** = `HTTP` (you can leave the port name at its default).

4. **Environment variables** (scroll down within the Container section →
   **Environment variables** → **Add environment variable** for each row):
   | Key           | Value                            |
   | ------------- | -------------------------------- |
   | `PORT`        | `8080`                           |
   | `AWS_REGION`  | `us-east-1`                      |
   | `TASKS_TABLE` | `Tasks`                          |
   | `CORS_ORIGIN` | your Amplify URL (from Part 1.4) |

   > `AWS_REGION` is often set automatically in Fargate, but setting it
   > explicitly here is harmless and makes the config self-documenting.

5. **Logging** (also within the Container section)
   - Leave **Use log collection** toggled **on** — the console creates an
     `awslogs` driver sending container output to CloudWatch Logs. (This is the
     renamed "CloudWatch logs" option from the older UI.)

6. Leave **Storage**, **Monitoring**, and **Tags** at their defaults.

7. Click **Create**.

> **Not seeing these sections?** If your console shows a single long form or a
> "JSON" editor instead, you're likely in the classic console or on the JSON
> tab. Switch to the standard **Create new task definition** form; the sections
> above (Task definition configuration → Infrastructure requirements →
> Container) are the current default experience.

### 2.9 Create the service behind an internet-facing ALB

Open your cluster (`sample-app-cluster`) → the **Services** tab → **Create**.
The new console groups the form into collapsible sections:

1. **Environment** (sometimes shown as "Compute configuration")
   - **Compute options:** **Launch type**
   - **Launch type:** **FARGATE**, **Platform version:** **LATEST**

2. **Deployment configuration**
   - **Application type:** **Service**
   - **Task definition — Family:** `sample-app-backend`, **Revision:** the latest
     (the one from 2.8)
   - **Service name:** `sample-app-service`
   - **Desired tasks:** `1`

3. **Networking**
   - **VPC:** pick your VPC.
   - **Subnets:** choose **private** subnets for a clean setup (tasks get no
     public IP), or public subnets if you want to skip NAT for the demo.
   - **Security group:** create a new one (this is the **task SG**) — you'll
     tighten it in step 5 so only the ALB can reach port `8080`.
   - **Public IP:** **Turned off** for private subnets; **Turned on** only if you
     put the tasks in public subnets without NAT.
   - The tasks must reach DynamoDB: add a **DynamoDB gateway VPC endpoint**
     (free, recommended) or ensure a **NAT gateway** exists for private subnets.

4. **Load balancing**
   - **Load balancer type:** **Application Load Balancer**
   - **Application Load Balancer:** **Create a new load balancer**
   - **Load balancer name:** `sample-app-alb`
   - **Scheme:** this is set when the ALB is created — it must be
     **internet-facing** (the browser calls it directly; an internal ALB would be
     unreachable from Amplify). The service wizard creates an internet-facing ALB
     by default; if you created the ALB separately, make sure you chose
     internet-facing.
   - **Listener:** create a new one on **port 80 / HTTP** (or 443/HTTPS with an
     ACM certificate).
   - **Target group:** create a new one — **protocol HTTP**, the console sets
     target type to **IP** for Fargate automatically.
   - **Health check path:** `/health`  (the app exposes this; override the
     default `/` here).

5. **After the service is created — lock down the security groups** (EC2 console
   → Security Groups):
   - **ALB SG:** inbound `80`/`443` from `0.0.0.0/0`.
   - **Task SG:** inbound `8080` **only from the ALB security group** (set the
     source to the ALB SG, not an IP range).

6. Click **Create**. When the service stabilizes and the target is **healthy**,
   find the **ALB DNS name** in the EC2 → Load Balancers console:
   ```
   http://sample-app-alb-123456.us-east-1.elb.amazonaws.com
   ```
   This is your `VITE_API_BASE_URL` for Part 1.3.

### 2.10 Verify the backend

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

- **`docker build` fails with "Cannot connect to the Docker daemon ... Is the docker daemon running?"** → the Docker service isn't started. Run `sudo systemctl start docker` (and `sudo systemctl enable docker` so it starts on reboot). See step 2.2.
- **`docker` fails with "permission denied" on `/var/run/docker.sock`** → your user isn't in the `docker` group. Run `sudo usermod -aG docker $USER` then `newgrp docker`, or prefix the command with `sudo` as a quick test.
- **`docker push` fails with "no basic auth credentials"** → you logged in as one user and pushed as another. `docker login` and `docker push` must run as the **same** user, because `sudo` (root) and your user keep separate Docker configs. Either drop `sudo` for both, or use `sudo` for both (`sudo docker login ...` and `sudo docker push ...`). The token also expires after 12 hours — re-run `docker login` if needed.
- **Image builds with an empty/odd name** → the `$ECR_REPO`/`$AWS_REGION`/`$AWS_ACCOUNT_ID` variables aren't set in the current shell. Re-run the `export` lines from step 2.5 and verify with `echo "$ECR_REPO"`.
- **Frontend loads but tasks fail to load** → `VITE_API_BASE_URL` wrong/missing, or CORS. Check the browser console; set `CORS_ORIGIN` on the backend to the exact Amplify origin.
- **`/health` shows `in-memory`** → container can't reach DynamoDB. Check task role policy, region, table name, and that the tasks have a network path to DynamoDB (VPC endpoint or NAT).
- **ECS task won't start / can't pull image** → task *execution* role missing ECR permissions, or wrong image URI.
- **ALB targets unhealthy** → health check path must be `/health`, target group port must be `8080`, and the task SG must allow `8080` from the ALB SG.
- **502 from ALB** → container not listening on `8080` or still starting; check CloudWatch logs.
