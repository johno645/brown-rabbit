#!/bin/bash

# Configure default service account to use GHES registry secret
kubectl patch serviceaccount default -p '{"imagePullSecrets": [{"name": "ghes-registry-secret"}]}'

# For specific namespace
kubectl patch serviceaccount default -n your-namespace -p '{"imagePullSecrets": [{"name": "ghes-registry-secret"}]}'

# Verify the configuration
kubectl get serviceaccount default -o yaml