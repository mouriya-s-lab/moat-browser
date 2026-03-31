output "vm_id" {
  description = "The Proxmox VM ID of the browser VM"
  value       = proxmox_virtual_environment_vm.browser.vm_id
}

output "vm_name" {
  description = "The name of the browser VM"
  value       = proxmox_virtual_environment_vm.browser.name
}

output "ipv4_address" {
  description = "The IPv4 address of the browser VM"
  value       = proxmox_virtual_environment_vm.browser.ipv4_addresses
}
