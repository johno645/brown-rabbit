# GitHub Enterprise Server Container Registry Setup for EKS

This guide explains how to configure your EKS cluster to pull container images from your GitHub Enterprise Server (GHES) container registry.

## Prerequisites

- GHES instance with container registry enabled
- EKS cluster with Karpenter deployed
- kubectl configured for your cluster
- Authentication method (choose one):
  - Personal Access Token (PAT) with `read:packages` permission
  - GitHub App with repository-specific access (recommended for better security)

## Step 1: Choose Authentication Method

### Option A: Personal Access Token (PAT)

1. Navigate to your GHES instance
2. Go to **Settings** → **Developer settings** → **Personal access tokens**
3. Generate a new token with the following scopes:
   - `read:packages` (required for pulling images)
   - `write:packages` (if you need to push images)
   - `delete:packages` (if you need to delete images)

### Option B: GitHub App (Recommended for Repository-Specific Access)

**Note**: GHES doesn't support repository-specific PATs like GitLab, but GitHub Apps provide similar granular access control.

1. **Create GitHub App**:
   - Go to **Settings** → **Developer settings** → **GitHub Apps**
   - Click **New GitHub App**
   - Set permissions: `Contents: Read`, `Packages: Write`, `Metadata: Read`

2. **Install on specific repositories**:
   - After creation, install the app only on repositories that need registry access
   - This provides repository-scoped access similar to GitLab project tokens

3. **Use in workflows**:
   - See `github-runners/examples/github-app-auth.yaml` for implementation
   - See `github-runners/setup/github-app-setup.md` for detailed setup guide

**Benefits of GitHub Apps over PATs**:
- Repository-specific access (not user-wide)
- Automatic token rotation (1-hour expiry)
- Better audit trail and attribution
- Can be revoked per repository

## Step 2: Create Kubernetes Registry Secret

### Method A: Using kubectl (Recommended)

```bash
# Replace with your actual values
GHES_DOMAIN="ghes.your-company.com"
GHES_USERNAME="your-username"
GHES_TOKEN="your-pat-token"
NAMESPACE="default"

kubectl create secret docker-registry ghes-registry-secret \
  --docker-server=$GHES_DOMAIN \
  --docker-username=$GHES_USERNAME \
  --docker-password=$GHES_TOKEN \
  --docker-email=$GHES_USERNAME@your-company.com \
  --namespace=$NAMESPACE
```

### Method B: Using YAML manifest

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: ghes-registry-secret
  namespace: default
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64-encoded-docker-config>
```

To generate the base64 encoded config:

```bash
# Create the docker config JSON
cat <<EOF | base64 -w 0
{
  "auths": {
    "ghes.your-company.com": {
      "username": "your-username",
      "password": "your-pat-token",
      "email": "your-username@your-company.com",
      "auth": "$(echo -n 'your-username:your-pat-token' | base64 -w 0)"
    }
  }
}
EOF
```

## Step 3: Configure Default Service Account (Optional)

To avoid specifying `imagePullSecrets` in every pod:

```bash
# For default namespace
kubectl patch serviceaccount default -p '{"imagePullSecrets": [{"name": "ghes-registry-secret"}]}'

# For specific namespace
kubectl patch serviceaccount default -n your-namespace -p '{"imagePullSecrets": [{"name": "ghes-registry-secret"}]}'
```

## Step 4: Update Karpenter Node Configuration

The Bottlerocket configuration in your CDK stack has been updated to support GHES registries. Make sure to:

1. Replace `ghes.your-company.com` with your actual GHES domain
2. Add your GHES domain to the `no-proxy` list if using a proxy
3. Deploy the updated CDK stack

## Step 5: Test Image Pull

Create a test pod to verify the configuration:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-ghes-pull
spec:
  containers:
  - name: app
    image: ghes.your-company.com/your-org/your-repo:latest
    command: ["sleep", "3600"]
  imagePullSecrets:
  - name: ghes-registry-secret
  restartPolicy: Never
```

Apply and check:

```bash
kubectl apply -f test-pod.yaml
kubectl get pod test-ghes-pull
kubectl describe pod test-ghes-pull
```

## Step 6: GitHub Actions Integration

For GitHub Actions runners, use the provided workflow example in `github-runners/examples/podman-workflow.yaml`.

### Required Secrets and Variables

Set these in your repository settings:

**Secrets:**
- `GHES_TOKEN`: Your personal access token

**Variables:**
- `AWS_REGION`: Your EKS cluster region
- `CLUSTER_NAME`: Your EKS cluster name
- `APP_NAMESPACE`: Target namespace for deployments

## Troubleshooting

### Common Issues

1. **ImagePullBackOff Error**
   ```bash
   kubectl describe pod <pod-name>
   # Check events for authentication errors
   ```

2. **Invalid Registry Credentials**
   ```bash
   # Verify secret content
   kubectl get secret ghes-registry-secret -o yaml
   kubectl get secret ghes-registry-secret -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d
   ```

3. **Network Connectivity**
   ```bash
   # Test from a pod
   kubectl run debug --image=busybox -it --rm -- nslookup ghes.your-company.com
   ```

4. **Certificate Issues**
   If using self-signed certificates, you may need to add them to the node trust store.

### Verification Commands

```bash
# Check if secret exists
kubectl get secrets | grep ghes-registry

# Verify service account configuration
kubectl get serviceaccount default -o yaml

# Test image pull manually
kubectl run test-pull --image=ghes.your-company.com/your-org/your-repo:latest --dry-run=client -o yaml
```

## Security Best Practices

1. **Use least privilege PATs**: Only grant necessary scopes
2. **Rotate tokens regularly**: Set up token rotation schedule
3. **Use namespace isolation**: Create secrets in specific namespaces
4. **Monitor access**: Enable audit logging for registry access
5. **Use service accounts**: Create dedicated service accounts for different workloads

## Registry URL Formats

Your GHES container registry URLs follow this pattern:

```
ghes.your-company.com/OWNER/REPOSITORY:TAG
```

Examples:
- `ghes.your-company.com/myorg/myapp:latest`
- `ghes.your-company.com/myorg/myapp:v1.2.3`
- `ghes.your-company.com/myorg/myapp:main-abc1234`

## Next Steps

1. Update your CDK configuration with your actual GHES domain
2. Deploy the updated infrastructure
3. Create registry secrets in your target namespaces
4. Test with a simple pod deployment
5. Integrate with your CI/CD pipelines