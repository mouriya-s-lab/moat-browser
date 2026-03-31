data "terraform_remote_state" "infra" {
  backend = "local"
  config  = { path = "../infra/terraform.tfstate" }
}

resource "proxmox_virtual_environment_vm" "browser" {
  vm_id     = var.vm_id
  name      = "browser"
  node_name = "pve"

  agent { enabled = true }

  cpu { cores = 4 }
  memory { dedicated = 8192 }

  disk {
    datastore_id = "local-lvm"
    file_id      = data.terraform_remote_state.infra.outputs.debian13_cloud_image_id
    interface    = "scsi0"
    size         = 50
  }

  network_device {
    bridge = "vmbr0"
  }

  initialization {
    ip_config {
      ipv4 { address = "dhcp" }
    }
    user_account {
      keys     = [var.ssh_public_key]
      password = var.root_password
      username = "root"
    }
  }

  lifecycle { ignore_changes = all }
}
