variable "vm_id" {
  description = "Proxmox VM ID for browser VM"
  type        = number
  default     = 104
}

variable "ssh_public_key" {
  description = "SSH public key for root access"
  type        = string
}

variable "root_password" {
  description = "Root password for cloud-init"
  type        = string
  sensitive   = true
}
