# Free Deployment Guide for CHROMEX

This guide explains how to deploy your CHROMEX app completely for free using GitHub, MongoDB Atlas, and Render.

## Prerequisites

- A GitHub account: [https://github.com/](https://github.com/)
- A MongoDB Atlas account (for database): [https://www.mongodb.com/atlas/database](https://www.mongodb.com/atlas/database)
- A Render account (for hosting): [https://render.com/](https://render.com/)

---

## Step 1: Push Code to GitHub

Since I have already initialized the local Git repository for you, follow these steps:

1.  **Create a New Repository on GitHub**:
    - Go to GitHub and click the **+** icon in the top right -> **New repository**.
    - Name it `chromex-trading`.
    - Make it **Public** (or Private).
    - Do **NOT** initialize with README, .gitignore, or License (we already have them).
    - Click **Create repository**.

2.  **Push Your Code**:
    - Copy the commands under "…or push an existing repository from the command line".
    - Run them in your terminal:
      ```bash
      git remote add origin https://github.com/YOUR_USERNAME/chromex-trading.git
      git branch -M main
      git push -u origin main
      ```

---

## Step 2: Set Up Free Database (MongoDB Atlas)

1.  Log in to [MongoDB Atlas](https://www.mongodb.com/atlas/database).
2.  Create a new **Project**.
3.  Click **Create a Cluster** -> Select **M0 Sandbox (Free Tier)**.
4.  Choose a provider (AWS) and region (closest to you). Click **Create**.
5.  **Security Quickstart**:
    - **Username/Password**: Create a database user (e.g., `chromex_user`). **Save the password!**
    - **IP Access List**: Add `0.0.0.0/0` (Allow Access from Anywhere) so Render can connect.
6.  **Get Connection String**:
    - Go to **Database** -> **Connect** -> **Drivers**.
    - Copy the connection string (e.g., `mongodb+srv://<username>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority`).
    - Replace `<password>` with your actual password.

---

## Step 3: Deploy on Render (Free Web Service)

Since I have added a `render.yaml` file to your project, you can deploy even faster using "Blueprints".

1.  Log in to [Render](https://render.com/).
2.  Click **New +** -> **Blueprint**.
3.  Connect your GitHub account and select the `color_trading` repo.
4.  Render will automatically detect the configuration from `render.yaml`.
5.  **Environment Variables**:
    - You will see a prompt to enter `MONGODB_URI`.
    - Paste your MongoDB connection string from Step 2.
6.  Click **Apply**.

---

## Step 4: Verify Deployment

- Render will start building your app. It may take a few minutes.
- Once deployed, you will see a URL like `https://chromex-app.onrender.com`.
- Open the link. Your app should be live!

## Troubleshooting

- **Logs**: Check the "Logs" tab in Render if the deployment fails.
- **Database**: Ensure you replaced `<password>` correctly in the connection string and added `0.0.0.0/0` to the IP whitelist in MongoDB Atlas.
