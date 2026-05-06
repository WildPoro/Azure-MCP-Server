# Azure MCP Server

A Model Context Protocol (MCP) server that enables AI assistants (such as GitHub Copilot Chat) to interact with Azure infrastructure using natural language.

This project allows AI to perform real cloud operations through controlled tools such as listing resources, creating resource groups, and safely deleting resources with validation rules.

---

## 🚀 Features

- 📋 List Azure resources in a subscription  
- 🏗️ Create Azure resource groups  
- 🗑️ Safely delete Azure resources (with validation rules)  
- 🔐 Built-in safety constraints for destructive operations  
- 🤖 Designed for integration with AI assistants via MCP

---

## 🧠 Architecture

User (natural language)
↓
AI (Copilot / LLM)
↓
MCP Server (this project)
↓
Azure SDK (real infrastructure actions)


The MCP server acts as a secure bridge between AI and Azure.

---

## ⚙️ Prerequisites

- Node.js (v18+ recommended)
- Azure CLI installed and logged in
- Azure subscription
- Permissions to manage resources

Login to Azure:

```bash
az login

git clone https://github.com/your-username/azure-mcp-server.git
cd azure-mcp-server
