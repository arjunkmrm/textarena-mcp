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
        
        // Define truth verification tool schema
        const truthVerificationTool = {
          name: "verify_facts",
          description: "Compares two input facts with a facts dataset and returns which fact is correct",
          inputSchema: {
            type: "object",
            properties: {
              fact1: {
                type: "string",
                description: "First fact as a string"
              },
              fact2: {
                type: "string",
                description: "Second fact as a string"
              }
            },
            required: ["fact1", "fact2"]
          },
          outputSchema: {
            type: "string",
            description: "The correct fact designation ('fact1' or 'fact2') or error message"
          }
        };
        
        // Merge tools from all sources
        const mergedTools = [...nltkTools.tools, ...pokerTools.tools, truthVerificationTool];
        
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
        } else if (request.params.name === 'verify_facts') {
          // Handle the verify_facts tool
          try {
            const args = request.params.arguments as Record<string, unknown>;
            const fact1 = args.fact1 as string;
            const fact2 = args.fact2 as string;
            
            // Get the path to facts.json in the same directory as this file
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const factsPath = path.join(__dirname, "facts.json");
            
            // Load the facts dataset
            const fs = await import('fs/promises');
            let factsDataset;
            try {
              const factsData = await fs.readFile(factsPath, 'utf8');
              factsDataset = JSON.parse(factsData);
            } catch (err) {
              return {
                content: [{
                  type: "text",
                  text: `Error loading facts database: ${err instanceof Error ? err.message : String(err)}`
                }],
                isError: true
              };
            }
            
            // Look for an exact match first
            for (const item of factsDataset) {
              if ((item.facts.fact1 === fact1 && item.facts.fact2 === fact2) || 
                  (item.facts.fact1 === fact2 && item.facts.fact2 === fact1)) {
                // If found, return which fact is correct
                let correctFactDesignation;
                if (item.facts.fact1 === fact1) {
                  correctFactDesignation = item.correct_fact;
                } else {
                  // Flip the result if facts were in reverse order
                  correctFactDesignation = item.correct_fact === "fact2" ? "fact1" : "fact2";
                }
                
                return {
                  content: [{
                    type: "text",
                    text: correctFactDesignation
                  }]
                };
              }
            }
            
            // If no exact match, find the closest match
            let closestMatch = null;
            let highestSimilarity = 0;
            let isFlipped = false;
            
            // Helper function to calculate string similarity (equivalent to Python's difflib)
            const calculateSimilarity = (str1: string, str2: string): number => {
              const len1 = str1.length;
              const len2 = str2.length;
              
              if (len1 === 0 || len2 === 0) {
                return 0;
              }
              
              // Create a matrix to store the lengths of longest common subsequences
              const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
              
              // Fill the matrix
              for (let i = 1; i <= len1; i++) {
                for (let j = 1; j <= len2; j++) {
                  if (str1[i - 1] === str2[j - 1]) {
                    matrix[i][j] = matrix[i - 1][j - 1] + 1;
                  } else {
                    matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
                  }
                }
              }
              
              // Calculate similarity ratio
              const lcs = matrix[len1][len2];
              return (2.0 * lcs) / (len1 + len2);
            };
            
            for (const item of factsDataset) {
              // Check similarity for both arrangements
              const similarity1 = (
                calculateSimilarity(fact1, item.facts.fact1) +
                calculateSimilarity(fact2, item.facts.fact2)
              );
              
              const similarity2 = (
                calculateSimilarity(fact1, item.facts.fact2) +
                calculateSimilarity(fact2, item.facts.fact1)
              );
              
              // Get the best arrangement and its similarity score
              let currentSimilarity, currentMatch, currentFlipped;
              
              if (similarity1 > similarity2) {
                currentSimilarity = similarity1 / 2;
                currentMatch = item;
                currentFlipped = false;
              } else {
                currentSimilarity = similarity2 / 2;
                currentMatch = item;
                currentFlipped = true;
              }
              
              // Update if this is the best match so far
              if (currentSimilarity > highestSimilarity) {
                highestSimilarity = currentSimilarity;
                closestMatch = currentMatch;
                isFlipped = currentFlipped;
              }
            }
            
            // If we found a sufficiently similar match (threshold of 0.6)
            if (closestMatch && highestSimilarity > 0.6) {
              let result;
              if (!isFlipped) {
                result = closestMatch.correct_fact;
              } else {
                // Flip the result if facts were matched in reverse order
                result = closestMatch.correct_fact === "fact2" ? "fact1" : "fact2";
              }
              
              return {
                content: [{
                  type: "text",
                  text: result
                }]
              };
            }
            
            // If no good match found
            return {
              content: [{
                type: "text",
                text: "No match found"
              }]
            };
          } catch (error: unknown) {
            console.error("Error processing verify_facts request:", error);
            return {
              content: [{
                type: "text", 
                text: `Error verifying facts: ${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        } else if (request.params.name === 'analyse_cards') {
          // For poker tools
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
        } else {
          // Handle unknown tool
          console.error(`Unknown tool requested: ${request.params.name}`);
          return {
            content: [{
              type: "text",
              text: `Unknown tool: ${request.params.name}`
            }],
            isError: true
          };
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