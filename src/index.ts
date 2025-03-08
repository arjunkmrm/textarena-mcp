#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTransport } from "@smithery/sdk/transport.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from 'ws';

// Create a compatible WebSocket global
if (typeof global.WebSocket === 'undefined') {
  // @ts-ignore - Ignoring type mismatch as ws implementation works at runtime
  global.WebSocket = WebSocket;
}

export class SpellingBeeServer {
  private server: Server;

  constructor() {
    this.server = new Server({
      name: "textarena-mcp",
      version: "0.1.0"
    }, {
      capabilities: {
        tools: {}
      }
    });

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        // Create NLTK transport and client
        const nltkTransport = createTransport("https://server.smithery.ai/@kwen1510/nltk-map", {});
        const nltkClient = new Client({
          name: "NLTK client",
          version: "1.0.0"
        });
        await nltkClient.connect(nltkTransport);
        
        // Get NLTK tools
        const nltkTools = await nltkClient.listTools();
        
        // Create Poker transport and client
        const pokerTransport = createTransport("https://server.smithery.ai/@watsonchua/poker_win_calculator", {});
        const pokerClient = new Client({
          name: "Poker client",
          version: "1.0.0"
        });
        await pokerClient.connect(pokerTransport);
        
        // Get Poker tools
        const pokerTools = await pokerClient.listTools();
        
        // Merge tools from both sources
        const mergedTools = [...nltkTools.tools, ...pokerTools.tools];
        
        // Return the merged tools
        return { tools: mergedTools };
      } catch (error) {
        console.error("Error fetching tools:", error);
        return { tools: [] };
      }
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (request.params.name === 'get_longest_word') {
          const nltkTransport = createTransport("https://server.smithery.ai/@kwen1510/nltk-map", {});
          const nltkClient = new Client({
            name: "nltk client",
            version: "1.0.0"
          });
          await nltkClient.connect(nltkTransport);
          
          // Call the tool using the client
          const result = await nltkClient.callTool({
            name: request.params.name,
            arguments: request.params.arguments
          });
          
          return result;
        } else {
          // For analyse_cards and other poker tools
          const pokerTransport = createTransport("https://server.smithery.ai/@watsonchua/poker_win_calculator", {});
          const pokerClient = new Client({
            name: "poker client",
            version: "1.0.0"
          });
          await pokerClient.connect(pokerTransport);
          
          try {
            // Call the tool using the poker client
            const result = await pokerClient.callTool({
              name: request.params.name,
              arguments: request.params.arguments
            });
            
            return result;
          } catch (error: unknown) {
            console.error("Error processing request:", error);
            return {
              content: [{
                type: "text", 
                text: `Error: ${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }
      } catch (error) {
        console.error("Error calling tool:", error);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing tool: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Textarena MCP server running on stdio`);
  }
}

// Start the server
const server = new SpellingBeeServer();
server.run().catch(console.error); 