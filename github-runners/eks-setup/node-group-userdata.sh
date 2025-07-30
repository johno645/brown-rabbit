#!/bin/bash

# EKS Node Group User Data Script for Podman/Rootless Container Support
# This script configures EKS nodes to support rootless container builds

set -e

# Enable user namespaces (required for rootless containers)
echo "Enabling user namespaces..."
echo 'user.max_user_namespaces = 65536' >> /etc/sysctl.conf
echo 'user.max_pid_namespaces = 65536' >> /etc/sysctl.conf
echo 'user.max_net_namespaces = 65536' >> /etc/sysctl.conf
sysctl -p

# Install fuse-overlayfs (required for rootless overlay storage)
echo "Installing fuse-overlayfs..."
yum update -y
yum install -y fuse-overlayfs

# Install crun (modern container runtime with better rootless support)
echo "Installing crun..."
CRUN_VERSION="1.8.7"
curl -L "https://github.com/containers/crun/releases/download/${CRUN_VERSION}/crun-${CRUN_VERSION}-linux-amd64" \
    -o /usr/local/bin/crun
chmod +x /usr/local/bin/crun

# Configure containerd to use crun
echo "Configuring containerd for crun..."
mkdir -p /etc/containerd/
cat > /etc/containerd/config.toml << 'EOF'
version = 2

[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    [plugins."io.containerd.grpc.v1.cri".containerd]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            BinaryName = "/usr/local/bin/crun"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.crun]
          runtime_type = "io.containerd.runc.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.crun.options]
            BinaryName = "/usr/local/bin/crun"
EOF

# Set up subuid/subgid ranges for rootless containers
echo "Setting up subuid/subgid ranges..."
echo 'ec2-user:100000:65536' >> /etc/subuid
echo 'ec2-user:100000:65536' >> /etc/subgid

# Create systemd user directory for rootless services
echo "Setting up systemd user directories..."
mkdir -p /etc/systemd/user
mkdir -p /var/lib/systemd/linger

# Enable lingering for ec2-user (allows user services to run without login)
loginctl enable-linger ec2-user || true

# Install additional tools for container builds
echo "Installing build tools..."
yum install -y \
    git \
    tar \
    gzip \
    which \
    curl \
    wget

# Configure kernel parameters for better container performance
echo "Configuring kernel parameters..."
cat >> /etc/sysctl.conf << 'EOF'
# Container optimizations
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
kernel.keys.maxkeys = 2000
kernel.keys.maxbytes = 2000000
EOF
sysctl -p

# Set up storage optimization
echo "Optimizing storage for container builds..."
# Create dedicated partition for container storage if additional EBS volume is attached
if [ -b /dev/nvme1n1 ]; then
    mkfs.ext4 /dev/nvme1n1
    mkdir -p /var/lib/containers
    mount /dev/nvme1n1 /var/lib/containers
    echo '/dev/nvme1n1 /var/lib/containers ext4 defaults,noatime 0 2' >> /etc/fstab
    chmod 755 /var/lib/containers
fi

# Restart containerd to pick up new configuration
systemctl restart containerd

# Label the node for podman workloads
echo "Node setup complete for rootless container builds"

# Bootstrap EKS node (this must be last)
/etc/eks/bootstrap.sh ${CLUSTER_NAME} \
    --container-runtime containerd \
    --kubelet-extra-args '--node-labels=node-type=builder,podman-enabled=true'