.PHONY: plan-browser apply-browser destroy-browser provision-browser

plan-browser:
	cd terraform && terraform init && terraform plan

apply-browser:
	cd terraform && terraform init && terraform apply

destroy-browser:
	cd terraform && terraform destroy

provision-browser:
	cd ansible && ansible-playbook -i inventory.ini browser-vm.yml
