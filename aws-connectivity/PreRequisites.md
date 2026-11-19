- Important distinction: AWS EC2 APIs describe the cloud infrastructure. They cannot directly report guest OS information such as installed Windows drivers, BIOS serial numbers, RAM currently used, Windows product keys, or exact disk free space. AWS Systems Manager Inventory can supply additional OS-level details when the instance is configured as a managed node and inventory collection is enabled.

- user permisson needed ReadOnlyAccess in policy

