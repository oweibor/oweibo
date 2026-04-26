# infra/firecracker/Makefile
# Run: make all   (builds kernel + rootfs + guest agent)
# Outputs: /opt/firecracker/vmlinux, /opt/firecracker/rootfs.ext4
.PHONY: all kernel rootfs guest-agent clean

FIRECRACKER_BIN ?= /usr/local/bin/firecracker
KERNEL_VERSION  ?= 5.10.225
OUTPUT_DIR      ?= /opt/firecracker
ROOTFS_SIZE_MB  ?= 512

all: kernel rootfs guest-agent
	@echo "✓ Firecracker build complete. Artifacts in $(OUTPUT_DIR)"

kernel:
	@echo "→ Building Linux kernel $(KERNEL_VERSION)..."
	@mkdir -p $(OUTPUT_DIR)
	@if [ ! -f $(OUTPUT_DIR)/vmlinux ]; then \
	  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.8/x86_64/vmlinux-$(KERNEL_VERSION)" \
	    -o $(OUTPUT_DIR)/vmlinux && \
	  echo "✓ Kernel downloaded"; \
	else \
	  echo "  ✓ vmlinux already present — skipping"; \
	fi

rootfs:
	@echo "→ Building rootfs ($(ROOTFS_SIZE_MB)MB)..."
	@mkdir -p $(OUTPUT_DIR) /tmp/rootfs-mount
	@dd if=/dev/zero of=$(OUTPUT_DIR)/rootfs.ext4 bs=1M count=$(ROOTFS_SIZE_MB) 2>/dev/null
	@mkfs.ext4 -F $(OUTPUT_DIR)/rootfs.ext4
	@mount -o loop $(OUTPUT_DIR)/rootfs.ext4 /tmp/rootfs-mount
	@debootstrap --include=openssh-server,iproute2,curl,bash focal /tmp/rootfs-mount http://archive.ubuntu.com/ubuntu/ || \
	  (umount /tmp/rootfs-mount && exit 1)
	@# Install Node.js in rootfs
	@chroot /tmp/rootfs-mount /bin/bash -c \
	  "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
	@# Copy guest agent binary
	@cp guest/bin/guest-agent /tmp/rootfs-mount/usr/local/bin/guest-agent
	@chmod +x /tmp/rootfs-mount/usr/local/bin/guest-agent
	@# Set up systemd service for guest agent
	@cp guest/guest-agent.service /tmp/rootfs-mount/etc/systemd/system/
	@chroot /tmp/rootfs-mount systemctl enable guest-agent
	@umount /tmp/rootfs-mount
	@echo "✓ rootfs.ext4 built"

guest-agent:
	@echo "→ Building guest agent binary..."
	@cd guest && go build -o bin/guest-agent -ldflags="-s -w" ./cmd/agent
	@echo "✓ Guest agent built at guest/bin/guest-agent"

clean:
	@rm -f $(OUTPUT_DIR)/vmlinux $(OUTPUT_DIR)/rootfs.ext4
	@rm -f guest/bin/guest-agent
	@echo "✓ Clean complete"
