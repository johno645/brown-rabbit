# GitHub App Setup for Repository-Specific Access

Since GHES doesn't support repository-specific PATs, GitHub Apps provide the best alternative for granular access control.

## Creating a GitHub App

### 1. Create the App
1. Go to your GHES instance
2. Navigate to **Settings** → **Developer settings** → **GitHub Apps**
3. Click **New GitHub App**

### 2. Configure Basic Settings
- **GitHub App name**: `your-org-container-registry`
- **Description**: `Container registry access for CI/CD`
- **Homepage URL**: `https://your-company.com`
- **Webhook URL**: Leave blank (not needed for registry access)
- **Webhook secret**: Leave blank

### 3. Set Permissions
**Repository permissions:**
- **Contents**: Read (to access repository code)
- **Metadata**: Read (basic repository info)
- **Packages**: Write (to push/pull container images)

**Account permissions:**
- None needed for basic registry access

### 4. Installation Settings
- **Where can this GitHub App be installed?**: 
  - Choose "Only on this account" for organization-wide
  - Or "Any account" if you need broader access

## Installing the App

### 1. Install on Repositories
1. After creating the app, click **Install App**
2. Choose your organization
3. Select **Selected repositories**
4. Choose the specific repositories that need container registry access

### 2. Get App Credentials
After creation, note down:
- **App ID** (visible on the app settings page)
- **Private Key** (generate and download)

## Using in GitHub Actions

### 1. Add Secrets to Repository
Add these secrets to your repository:
- `GHES_APP_ID`: Your GitHub App ID
- `GHES_APP_PRIVATE_KEY`: The private key content

### 2. Workflow Configuration
Use the example in `github-app-auth.yaml`

## Alternative Approaches

### 1. **Organization-Level PAT with Restricted Scope**
```bash
# Create PAT with minimal scopes
# Scopes: read:packages, read:org (if needed)
# Use in specific repositories only
```

### 2. **Deploy Keys + Registry Access**
For read-only access, you can combine:
- Deploy keys for repository access
- Service account with registry permissions

### 3. **OIDC Token Exchange** (Advanced)
If your GHES supports it:

```yaml
permissions:
  id-token: write
  packages: write

steps:
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::ACCOUNT:role/GitHubActionsRole
    aws-region: us-east-1

- name: Get GHES token via OIDC
  run: |
    # Custom logic to exchange OIDC token for GHES access
    # This requires custom implementation
```

## Security Best Practices

### 1. **Principle of Least Privilege**
- Only grant necessary permissions
- Install apps on specific repositories only
- Regularly audit app installations

### 2. **Token Rotation**
- GitHub App tokens are short-lived (1 hour)
- Automatically refreshed by the action
- No manual rotation needed

### 3. **Monitoring**
- Enable audit logging for GitHub Apps
- Monitor registry access patterns
- Set up alerts for unusual activity

## Comparison: PAT vs GitHub App

| Feature | Personal Access Token | GitHub App |
|---------|----------------------|------------|
| **Scope Granularity** | User-level, broad scopes | Repository-specific |
| **Expiration** | Manual (up to 1 year) | Automatic (1 hour) |
| **Attribution** | User account | App identity |
| **Permissions** | User's permissions | Explicitly granted |
| **Revocation** | Manual | Automatic on uninstall |
| **Audit Trail** | User actions | App actions |

## Troubleshooting

### Common Issues

1. **App not installed on repository**
   ```bash
   # Error: Resource not accessible by integration
   # Solution: Install app on the specific repository
   ```

2. **Insufficient permissions**
   ```bash
   # Error: Resource not accessible by integration
   # Solution: Check app permissions include 'packages: write'
   ```

3. **Token generation fails**
   ```bash
   # Error: Invalid private key
   # Solution: Ensure private key is properly formatted in secrets
   ```

### Verification Commands

```bash
# Test app token generation locally (for debugging)
curl -X POST \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  https://ghes.your-company.com/api/v3/app/installations/INSTALLATION_ID/access_tokens
```

## Migration from PAT to GitHub App

1. **Create and configure GitHub App**
2. **Install on target repositories**
3. **Update workflows to use app authentication**
4. **Test thoroughly**
5. **Revoke old PATs**
6. **Update documentation**

This approach provides repository-specific access control similar to GitLab's project access tokens while maintaining security and auditability.